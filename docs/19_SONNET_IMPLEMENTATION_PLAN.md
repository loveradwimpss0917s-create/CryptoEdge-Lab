# 19. Sonnet 実装計画 — そのまま渡せるタスクカード集 (2026-07-05)

> **位置づけ**: docs/18 (Master Roadmap) の各タスクを、実装専任の Sonnet セッションへ
> そのまま渡せる粒度に展開したもの。1タスク = 1セッションを想定。
> 順序と依存は docs/18 §3 が正典。本書はカードの中身のみを持つ。

## 0. 共通実装規約 (全タスク冒頭に必ず適用)

1. 必読: 対象タスクの「関連docs」列 + docs/17 (監査) の該当節
2. 新パターンを発明しない。アダプタは `workers/ingest/src/adapters/` + `schedule.ts` 登録方式、
   APIは `apps/api/src/routes/` の Hono ルート方式、research ジョブは `jobs/` + workflow yml 方式
3. edge_version / eval の作成は必ず API 経由 (UIフォームまたは将来の Service Token)。
   **D1 直接 INSERT は禁止** (Edge Pack v1 Phase 1 限りの一時対応だった — ユーザー指示)
4. 完了手順: `pnpm turbo run typecheck test lint` 全緑 (research変更時は
   `research/.venv/bin/python -m pytest` も) → コミット → designated branch へ push →
   main への反映はユーザー承認後 → deploy.yml の Deploy 2ステップ成功確認 → 本番D1で読み取り検証
5. 本番で新規に外部APIを叩くアダプタは「1タスク1本」。デプロイ後の実tickでスキーマ検証し、
   失敗したら修正コミットを重ねる (SONNET-1 で確立したサイクル)
6. UI変更時は `wrangler dev --local` + `vite dev` + Playwright (Chromium,
   `/opt/pw-browsers` 配下) で実際にブラウザ操作して確認。ローカルAccess回避は
   `--var ENVIRONMENT:development` (設定ファイルは変更しない)
7. 結果は docs/19 の該当カードに「実行ログ」節を追記する (docs/15 方式の継承)

---

## Phase R1: V1 クローズアウト

### S-01: deploy.yml Smoke test の 302 恒常失敗を解消

- **WHY**: CI が毎回赤のため「本物の失敗」が埋もれる (docs/17 Z-6)。Asset too large 事故
  (f2ad81b) の際も全体 conclusion は普段と同じ failure で、ステップを開かないと区別できなかった
- **WHAT**: `.github/workflows/deploy.yml` の Smoke test ステップを修正。
  `/api/v1/healthz` が Cloudflare Access 配下で 302 を返すのが原因なので、
  (a) `curl -H` で Access Service Token を付ける (S-20 完了後) か、
  (b) 当面は「302 も『Workerが応答している』証拠」として 200/302 を成功扱いにする。
  まず (b) を実装し、S-20 後に (a) へ置換するTODOコメントを残す
- **DONE**: main への push で deploy.yml が緑になる
- **受入条件**: 直近 run が conclusion=success。かつ Worker を意図的に壊さない限り
  緑であり続けることをもう1回のデプロイで確認
- **関連docs**: docs/12, docs/17 §2 Z-6

### S-02: dq_issues 解決フロー

- **WHY**: 未解決40件が Action Queue / Data Health の信号を汚している (docs/17 §3.1-2)
- **WHAT**: (1) ingest Worker: `touchIngestState` で status='ok' 遷移時に、同一 stream_id の
  未解決 dq_issues を `resolved_at=now` で自動クローズ (DQ-02/DQ-TASK-DEAD 系、`env.DB.batch`で
  upsertと同一batchに)。
  (2) api: `POST /api/v1/data-health/:id/resolve` (手動クローズ、Access保護、`dq_issue.resolve`
  監査ログ)。
  (3) Data Health 画面 Open Issues リストに「解決」ボタン。(4) 既存の128件は retire 済みソース
  由来が大半なので、migration 0008 で `binance_rest/bybit_rest/coingecko` 系 stream の未解決
  issue を一括 resolve
- **DONE**: 本番の未解決件数が「現役ストリームの実問題」のみになる
- **受入条件**: `SELECT COUNT(*) FROM dq_issues WHERE resolved_at IS NULL` が
  実問題 (deribit等) の件数と一致。ストリーム回復→自動resolve を1件実証
- **関連docs**: docs/03 §6, docs/06 SCR-05, docs/15 SONNET-7 記録
- **実行ログ (2026-07-09)**: 実装完了。api 85件・ingest 73件のテスト green。migration 0008 は
  未適用 (次回デプロイで自動適用)

### S-91: eval_runs スタックジョブ監視 (新規タスク、監査で発見)

- **WHY**: `jobs` テーブルには `STUCK_DISPATCHED_MS` による自己修復 (internal.ts) があるが、
  `eval_runs.status='running'` には同等の仕組みがなく、research-worker がverdict提出前に
  死ぬ (Actions runner timeout/OOM/workflow cancel) と永久に'running'のまま残る。
  2026-07-09 監査で `cme-futures-gap-fill` run (`run_id=01KWN7C33MZ94ZRP26F659R0D5`) が
  2026-07-04 00:10:07 から133時間超'running'のまま放置されているのを発見
- **WHAT**: `apps/api/src/services/eval-runs.ts` に `reapStuckEvalRuns(env)` を新設。
  `started_at` が6時間 (screen/full runは通常分単位で終わる) 以上前で`status='running'`のままの
  行を`status='timeout'`, `finished_at=now`に更新。`jobs`同様、専用cronを新設せず
  `GET /api/v1/edges` (Explorerの一覧読み込み) の冒頭で毎回呼び出す lazy self-heal 方式
- **DONE**: 放置run_idが検出されたその日のうちに'timeout'へ遷移する。新規のスタックrunも
  Explorer画面を1回開けば自動的に片付く
- **受入条件**: `SELECT COUNT(*) FROM eval_runs WHERE status='running' AND started_at < (now - 6h)`
  が本番デプロイ後の次回Explorerアクセスで0件になる
- **関連docs**: docs/17 §3 (新規発見のP0候補として追記予定), docs/01 §4.6 (jobsの既存パターン)
- **実行ログ (2026-07-09)**: 実装完了。`apps/api/src/services/eval-runs.test.ts` 3件green
  (stuck→timeout / fresh→無変化 / done→無変化)

### S-94: CANDIDATE→TESTING ゲートが構造的に通過不能だった (最重要バグ、監査で発見)

- **WHY**: ユーザーから「まだ一つも候補 (CANDIDATE) から検証中 (TESTING) に移行できていない」と
  指摘を受け、本番D1を直接調査。`edge_transitions` を全件確認したところ、記録されている遷移は
  全7件とも `IDEA→CANDIDATE` のみで、`CANDIDATE→TESTING` の試行が**一度も記録されていなかった**。
  UI (`EdgeDetailScreen.tsx`) には遷移ボタン自体は既に実装・表示されており、押せば
  `POST /edges/:id/transition` は呼ばれる — つまりバックエンドのゲート判定が常に失敗する
  実装バグだった
- **原因**: `apps/api/src/services/edge-lifecycle.ts` の `latestScreenRun()` が
  `eval_metrics` を `segment = 'overall'` かつ `metric IN ('ev_bps','p_perm')` で問い合わせていたが、
  `research/.../eval/pipeline.py` の `run_eep()` は permutation test の結果を常に
  `segment='wf:oos'` にしか書き込まず、`segment='overall'` の `p_perm` 行は一度も存在しない。
  結果、`p_perm` は常に `undefined` となり `latestScreenRun()` は常に `null` を返し、
  ガードコンテキストは常に `{screenRunEvBps: -Infinity, screenRunPPerm: 1}` に固定される —
  つまりどのEdgeの実際の screen 結果が何であれ、このガードは**実装上絶対に合格しない**
  設計になっていた。docs/05 §2 の記述自体も `overall.p_perm` と誤って書かれており
  (2026-07 レビュー TASK-5 で記述された時点のミス)、コードとドキュメント両方が
  同じ誤った前提を共有していた
- **本番データでの実害確認**: 修正前のクエリで本番D1の CANDIDATE 6件の最新screen結果を確認したところ、
  「月曜アジア開場効果」(edge_id=01KWHQ6YVR5164JVBPS8TQS657) が
  `ev_bps(overall)=4.999 > 0` かつ `p_perm(wf:oos)=0.0647 < 0.20` で**両ゲートを実際にクリアしていた**
  にもかかわらず、バグにより永久にCANDIDATEに留め置かれていた
- **WHAT**: `latestScreenRun()` のSQLを `(segment='overall' AND metric='ev_bps') OR
  (segment='wf:oos' AND metric='p_perm')` に修正。`pipeline.py`/docs/05 のコメント記述も
  実際の書き込み先 (`wf:oos.p_perm`) に修正
- **DONE/受入条件**: `edge-lifecycle.test.ts` に回帰テスト追加
  (「`overall`セグメントのp_perm行だけではガードを満たさないこと」を明示的に検証)。
  本番データ (月曜アジア開場効果) で修正後にガードが実際に合格することを事前検証済み
- **関連docs**: docs/05 §2, docs/17 (次回監査で追記)
- **実行ログ (2026-07-11, Sonnet)**: 実装完了、`edge-lifecycle.test.ts` 5件green (新規1件含む)。
  デプロイ後、ユーザーがUIから「月曜アジア開場効果」の → TESTING ボタンを押せば
  実際に遷移するはずなので、次のアクションとして案内する
- **確認 (2026-07-11 追記)**: ユーザーが実際に本番UIで → TESTING を押し、edge_id
  01KWHQ6YVR5164JVBPS8TQS657 が本番D1で `status='TESTING'` に遷移したことを確認 —
  修正が実際に機能した。続けて full run が実行され `verdict=REJECT` で確定
  (S-95 参照: このverdictがUIの案内文と噛み合わない別バグを誘発した)

### S-95: FULL_DONE の案内文がverdictを無視していた (S-94の副次発見)

- **WHY**: S-94 デプロイ後、ユーザーが「月曜アジア開場効果」で
  「Research Readiness: FULL済み、次のアクション: verdictをレビュー→TESTING→VALIDATEDを判断」
  という文言に従おうとしたが、「そのようなボタンが無い」と報告。実際には
  full run の verdict が REJECT で確定しており (`canTransition` のガードは
  ADOPT 以外を必ず拒否 — docs/05 §2)、VALIDATEDへの遷移ボタン自体は
  `EDGE_TRANSITION_GRAPH` 通り表示されるが押しても失敗する。案内文がverdictの
  中身を見ずに固定文言 (`apps/web/src/lib/labels.ts` の `nextActionLabel`)
  を返していたため、ユーザーが正しい遷移 (→却下) に気づけなかった
- **WHAT**: `nextActionLabel` に `latestFullVerdict` 引数を追加し、FULL_DONE の
  文言を verdict 別に分岐 (ADOPT→VALIDATEDへ誘導 / REJECT・WATCH→却下へ誘導、
  ADOPT以外はVALIDATEDに進めない旨を明記)。`EdgeDetailScreen.tsx` の
  `ReadinessPanel` に既に取得済みの `data.runs` (直近5件、verdict込み) を渡し、
  最新の full run の verdict を検索して算出 — 新規APIコールは不要
- **DONE/受入条件**: `labels.test.ts` 新設 (4件: ADOPT/REJECT/WATCH/未確定の
  各分岐)。typecheck/lint/test/build 全緑
- **関連docs**: docs/06 §7.2
- **実行ログ (2026-07-11, Sonnet)**: 実装完了・デプロイ待ち

### S-96: PAPER→ACTIVE ゲートもS-94と同一原因で通過不能だった (予防修正)

- **WHY**: S-94 (CANDIDATE→TESTING) 修正後、同一バグクラス (ガードが期待するCI付きの
  metric行が実際には別のmetric名で書かれている) が他のゲートにも潜んでいないか
  横展開で監査。`apps/api/src/services/edge-lifecycle.ts` の `paperPerformance()` を確認
- **原因**: `eval/pipeline.py` の `_bundle_rows()` が `segment='wf:oos'` に書き込む
  素の `sharpe` 行は `ci_lo`/`ci_hi` を一切持たない (point estimateのみ)。CI付きの
  Sharpeは別の `bootstrap_ci()` 呼び出しが書く `sharpe_bootstrap` という別名の行にしかない。
  `paperPerformance()` は `metric = 'sharpe'` を問い合わせて `ci_lo`/`ci_hi` を期待していたため、
  常に `null` を受け取り `if (... || ci_lo === null || ci_hi === null) return null` で
  必ず `null` を返す → `ctx.PAPER_to_ACTIVE` が設定されず `guardPaperToActive` は
  常に "missing guard context" で失敗する構造だった。本番にまだPAPER到達Edgeが
  無いため実害は未発生 — S-94と同じ実装ミスが実際に踏まれる前に発見・修正できた
- **WHAT**: クエリの `metric = 'sharpe'` を `metric = 'sharpe_bootstrap'` に修正
- **DONE/受入条件**: `edge-lifecycle.test.ts` に新規describeブロック追加
  (CI無し`sharpe`行だけではガードを満たさないことを示す回帰テスト1件 +
  正しい`sharpe_bootstrap`行でガードが実際に通ることを示すテスト1件)。
  PAPER→ACTIVEパスはこれ以前テストが1件も無かった
- **関連docs**: docs/05 §2, docs/19 S-94
- **実行ログ (2026-07-11, Sonnet)**: 実装完了、`edge-lifecycle.test.ts` 7件green
  (新規2件含む)。typecheck/lint/test 全緑 (api 90件)。デプロイ待ち

### S-03: イベント履歴バックフィル (最重要)

- **WHY**: events が前方収集のみのため、イベント系Edge全てが歴史サンプルゼロで評価不能
  (docs/17 §3.1-1, ADR-1)。P0シード2件 (V1-3) と docs/14 Phase 3 のブロッカー
- **WHAT**: research 側に `jobs/events_backfill.py` を新設し、workflow (`research-on-demand`
  の manual input か専用 yml) から実行。3種を再構成して `POST /internal/events`
  (無ければ internal ルート追加) 経由で D1 へ:
  (1) `cme_gap`: yahoo_finance の BTC=F 日足履歴 (2019〜) から金曜close vs 日曜spot open、
  既存 `workers/ingest/src/adapters/yahoo-finance.ts` の判定ロジック (vol_adj<2% 等) を
  Python に忠実移植。判定閾値は adapter と定数を共有できないため、golden 1件で両実装の
  一致を確認する。(2) `usdt_mint`: etherscan の Tether Treasury 履歴 (≥$1B) — API上限に
  注意しページング。(3) `fomc`: 2019〜2025 の公式過去日程 (federalreserve.gov は
  research-worker (GitHub Actions) からは到達可能 — Workers egress 制約とは別)。
  dedupe_key は adapter と同一規約にし、前方収集と衝突しないこと
- **DONE**: events に cme_gap ~300件 / usdt_mint 数十件 / fomc ~56件 規模の歴史行
- **受入条件**: 本番D1 `SELECT event_type, COUNT(*), MIN(ts) FROM events GROUP BY 1` で
  3種とも2019年台のts。cme-gap-fill の eval が「イベント0件エラー」を出さず走る
- **関連docs**: docs/17 ADR-1, docs/14 §4.10-4.12, docs/09 §3
- **実行ログ (2026-07-11, Sonnet)**:
  - 実装: `packages/schema/src/api/internal.ts` に `submitEventsRequestSchema` を追加、
    `apps/api/src/routes/internal.ts` に `POST /internal/events` (dedupe_key で
    `ON CONFLICT DO NOTHING` — ingest側の `upsertEvent` と同一規約、テスト2件)。
    `research/.../io/internal_client.py` に `EventInput`/`submit_events()` を追加 (テスト1件)。
    `research/.../jobs/events_backfill.py` を新設:
    `backfill_cme_gap` (Yahoo Finance BTC=F 全期間日足 → `computeCmeGap` と同一ロジックを
    Python移植、全履歴の連続ペアを走査してギャップを全件検出)、
    `backfill_usdt_mint` (Etherscan Tether Treasury 転送履歴を1000件/pageでページング、
    ゼロアドレス発のmintのみ抽出)。両方とも純粋ロジック関数はfixtureで単体テスト済み
    (`test_events_backfill.py` 9件)、HTTPラッパーは `httpx.MockTransport` で検証。
    `.github/workflows/events-backfill.yml` (workflow_dispatch のみ、手動実行)
  - **fomc は未実装 — 意図的にブロック中**: `FOMC_HISTORICAL_DATES` は空リストのまま出荷
    (`workers/ingest/src/adapters/econ-calendar.ts` の `ECON_CALENDAR` と全く同じ理由・同じ方針)。
    本サンドボックスから `federalreserve.gov`/`stooq.com` 含む外部ホストへのネットワークアクセスが
    プロキシポリシーで遮断されており (403)、2019〜2025年のFOMC会合日程を実データで検証できない。
    本カード自身が「federalreserve.gov は research-worker (GitHub Actions) からは到達可能」と
    明記している通り、これは実際のGitHub Actions実行環境 (実ネットワークあり) が担うべき仕事で、
    このセッションで訓練データの記憶から日付を捏造すべきではない
    (誤った日付は全てのイベント参照signal_specの評価を静かに壊す — econ-calendar.tsの既存方針)。
    ユーザーが検証済みの日程リストを提供するか、実ネットワークのあるセッションで
    federalreserve.gov の `fomchistorical{YYYY}.htm` から取得・検証してから
    `FOMC_HISTORICAL_DATES` を埋めること
  - **副産物のバグ修正**: `apps/api`/`workers/ingest` 両方の `FakeD1` テストダブルが
    `.run()`/`.all()` の戻り値に `meta.changes` を含めておらず、「written = changes > 0」
    という頻出パターン (touchIngestState の dq_issues 自動解決、upsertEvent 含む) を
    実際にテストしようとすると `Cannot read properties of undefined (reading 'changes')` で
    必ず落ちる状態だった (本番の実D1では問題なし、テストダブルのみの欠陥)。
    `node:sqlite` の `stmt.run()` が元々 `{changes, lastInsertRowid}` を返すため、
    それを `meta.changes` として再整形するだけで修正
  - typecheck/lint/test 全緑: TS 15タスク (api 87件・ingest 74件・web 4件など)、
    Python 197件 (ruff check 含む)
  - **実行ログ追記 (2026-07-11、ユーザー承認の上で本番実行)**: `events-backfill.yml` を
    workflow_dispatch で実行 (run 29169725916, 成功)。ログ:
    `cme_gap: 410 candidate event(s), 410 newly written` /
    `usdt_mint: skipped, ETHERSCAN_API_KEY not configured` /
    `fomc: skipped, FOMC_HISTORICAL_DATES is empty`。
    本番D1で確認: `events` テーブルに `cme_gap` 410件 (ts range 2019-01-07〜2026-07-11) が
    実在。Yahoo Finance の実APIへの初回本番接続が成功し、コード側の懸念
    (fixtureとの形式差異によるジョブ失敗) は杞憂に終わった。
    `usdt_mint` はユーザーが `ETHERSCAN_API_KEY` シークレットを設定後、
    workflow_dispatch を再実行すれば同様に動く見込み (コードは実装済み・テスト済み)

### S-04: P0シード残2件の評価完了

- **WHY**: V1-3。S-03 完了で評価可能になる
- **WHAT**: ユーザーに UIフォームからの eval 実行を依頼 (cme-gap-fill / usdt-mint-drift は
  edge_version 作成済み・signal_spec正 — docs/15 SONNET-3 で確認済み)。Sonnet は
  結果 (n/EV/Sharpe/DSR/p_perm/verdict) を本番D1で検証し docs/19 に記録。状態遷移はユーザー判断
- **DONE/受入条件**: 2件に verdict 行。V1-3 の表を更新
- **関連docs**: docs/09 §3, docs/15 SONNET-3

### S-05: V1 DoD 7日実測レポート

- **WHY**: V1-1/V1-2 の実証。V1完了宣言の根拠文書
- **WHAT**: S-01/S-02 デプロイ後7日間を計測窓とし、(a) Data Health API の品質スコア日次記録
  (7日分、disabled除く全ストリーム)、(b) `quota_usage` 7日分 vs docs/13 §1 予算表、
  (c) 再現性8点 (docs/02 §6) を utc-2123-drift で1件実記録。結果を docs/18 §2 の表に書き込み、
  レポート本文は docs/19 本カードの実行ログ節へ
- **DONE**: docs/18 §2 V1表の全行に実測値ベースの ✅/❌
- **受入条件**: ❌ が残る場合、各々に是正タスクの起票があること
- **関連docs**: docs/09 §2, docs/13 §1, docs/02 §6

### S-06: deribit 72時間ルール適用

- **WHY**: 429 が13時間継続中 (監査時点)。binance 型の恒久ブロックか判定が必要 (ADR-6)
- **WHAT**: 72h 経過時点の ingest_state を確認。(a) 回復していれば S-06 をクローズし、
  b7c6090 の24hバックフィルで欠損が埋まったことを options_surface で確認。
  (b) 継続中なら第一段: `STREAMS_1H` → `STREAMS_1D` へ移して頻度を 1/24 に落とし24h観察。
  (c) それでも429なら retire (migration で deribit_rest を disabled + docs/03 追記 +
  Data Health 折りたたみ行き)。retire 時は S-19 (VRP) を「不可」で自動クローズ
- **DONE**: 3分岐のいずれかが実施され記録されている
- **受入条件**: Data Health から deribit の赤表示が消える (回復 or disabled)
- **関連docs**: docs/17 §3.2-5 / ADR-6, docs/03 §2.1
- **実行ログ (2026-07-11, Sonnet) — 分岐(a)で判断、close**: 本番D1の `dq_issues`
  (stream_id LIKE 'deribit_rest%') を時系列で確認したところ、2026-07-03〜2026-07-11の
  8日間、検知→解決を繰り返す**断続的429**パターンで、binance_rest/bybit_rest/coingecko
  (migration 0007 で実際に恒久ブロックと確定・disabled化) のような「一度も回復しない」
  パターンとは明確に異なる。現在 `ingest_state.watermark_ts` も直近数時間以内まで
  進んでおり (データは実際に流れている)、`dq_issues` の open件数は0件 (全50件resolved)。
  これは `workers/ingest/src/adapters/types.ts` の `jitterDelay` コメントが説明する
  「Cloudflare Workers共有egress IPプールによる、こちら側のバーストが無くても起こる
  ノイズ」パターンと一致し、`consecutive-errors.ts` が429を通常障害より高い閾値(6)で
  扱っている設計判断とも整合する。**降格・retireの必要なし — 既存のリトライ+S-02自動解決
  インフラで適切に吸収されている。分岐(b)/(c)は不要と判断してclose**

### S-07: Explorer クローズアウト

- **WHY**: credentials 修正 (28a1797) まで2段の推測修正の効果が未確認 (docs/17 §3.3-11)
- **WHAT**: ユーザーの実ブラウザ確認を待つ。NG の場合: lake ルートに一時診断を追加
  (受信した Cookie 有無・Range ヘッダを console.log し `wrangler tail` で観察) して
  実際の失敗点を特定してから修正する。**これ以上の推測修正の積み重ねは禁止**
- **DONE**: 実ブラウザでヒストグラム表示成功のユーザー確認
- **受入条件**: iOS Safari と desktop の両方で成功報告。診断コードは撤去してからクローズ
- **関連docs**: docs/15 §8, docs/17 ADR-3

## Phase R2: V1.5 (代表カードのみ抜粋 — 残りは同形式で起票済みの docs/18 §3 表に従う)

### S-08: Edge Pack Phase 2 screen (weekly-breakout + round-number)

- **WHY**: 追加実装ほぼゼロで評価母数+2 (docs/14 §4.8-4.9)
- **WHAT**: `weekly_high_dist` FeatureDef は投入済み (53092cf)。features_sync 再計算を
  workflow 実行で確認 → ユーザーがUIから signal_spec 投入 (docs/14 の JSON をそのまま) →
  screen。round-number は `ops.round_number_dist` 新設 + FeatureDef + 同フロー
- **DONE/受入条件**: 2件に screen verdict。falsification 想定 (REJECT でも成功) を報告に明記
- **関連docs**: docs/14 §4.8-4.9

### S-10: defillama アダプタ (残アダプタ第1弾)

- **WHY**: 分類C解除の開始。キー不要で最安 (docs/15 SONNET-6 が次点候補と明記済み)
- **WHAT**: `adapters/defillama.ts` (stablecoin mcap → `stable.usdt_mcap` /
  `stable.total_stable_mcap`、metric_defs 登録済み)。`STREAMS_1D` 登録。
  実tickでのスキーマ検証サイクル (共通規約5) を厳守
- **DONE/受入条件**: 本番 metrics テーブルに日次行。Data Health で品質スコア表示
- **関連docs**: docs/03 §2.3, docs/15 SONNET-6

### S-15: Feature live ミラー (paper trading の cmp 対応)

- **WHY**: paper trading が feature 参照Edgeを扱えない構造制約の解消 (docs/17 §3.1-3)
- **WHAT**: features_sync.py の最後で、各 instrument の最新1行 (全feature値) を
  `POST /internal/feature-latest` (新設) → `latest_snapshots` へ (key 例:
  `feature:{instrument}:{name}`)。ingest 側 `signals/paper-trading.ts` の
  `buildLiveDslInput` が cmp ノード評価時にこれを読む。**鮮度ガード必須**:
  スナップショットが 2h より古い場合は fail-closed (発火させずログ) — 捏造しない原則
- **DONE**: cmp を含む PAPER Edge がシグナルを記録できる
- **受入条件**: 単体テスト (鮮度ガード含む) + ローカルE2Eで cmp Edge の発火を実証
- **関連docs**: docs/15 SONNET-5, docs/17 §3.1-3

### S-16: funding コストのバックテスト反映

- **WHY**: funding保有系Edgeの経済性が系統的に歪む (docs/14 §1.3)
- **WHAT**: `research/eval/backtest.py` の CostModel に funding を追加。保有期間中の
  実 funding_rate 系列 (funding_rates テーブル、8h毎) を方向符号付きで積算し ret_net へ。
  `cost_model.funding_included=true` の version のみ適用 (後方互換)。
  ingest 側 paper-trading.ts の `roundTripCostBps` にも同モデルを移植し PAPER/FULL の
  比較可能性を維持 (funding はhorizon依存なので固定bpsではなく実効値で)
- **DONE**: funding-rate-mean-reversion を funding_included=true で再評価できる
- **受入条件**: golden テスト (既知の funding 系列での期待値一致)。既存 false 指定の
  結果が変わらないこと (回帰)
- **関連docs**: docs/14 §1.3/§4.5, docs/05

### S-20: Access Service Token 認証

- **WHY**: kasotubot / CI / エージェントの機械認証を1本化 (docs/17 ADR-2)。S-23 の前提
- **WHAT**: `middleware/require-access.ts` を拡張: `CF-Access-Client-Id/Secret` ヘッダ
  由来の service token JWT (Access が `Cf-Access-Jwt-Assertion` に載せる、`sub` が空で
  `common_name` を持つ) を許容し、`userEmail` の代わりに `service:{common_name}` を
  actor として記録。ユーザーには Cloudflare ダッシュボードでの token 発行手順を依頼
  (Sonnet は検証用 curl 手順を提示)。audit ログの actor 区別を確認
- **DONE**: token 付き curl で `POST /api/v1/edges/:id/eval` が通る
- **受入条件**: token 無し・不正 token が 401。既存ブラウザフローに回帰なし
  (access-jwt.test.ts に service token ケース追加)
- **関連docs**: docs/01 §5, docs/17 ADR-2

### (同形式で起票済み: S-09 FOMC 2件+cpi修正 / S-11 fred / S-12 coinmetrics /
S-13 farside+tronscan判断 / S-14 LS/OIバックフィル再試行 / S-17 dom_in /
S-18 D1 retention / S-19 VRP要承認 / S-21 wrangler v4 / S-22 wasm R2自己ホスト —
各カードの WHY/依存 は docs/18 §3、詳細設計の参照先は docs/14 §4.10-4.14・docs/17 §3)

## Phase R3: kasotubot 連携 (S-23〜S-26)

カードの実体は docs/20 §6 に置く (契約と実装を1箇所で管理するため)。着手条件: S-20 完了 +
ユーザーによる kasotubot 側方針の確認。

## S-90: docs 小修正バッチ (随時)

- **WHAT**: docs/17 §4 の「小修正」判定分 — docs/02 列追記 / docs/06 実装済み注記 /
  docs/14 §1.1 件数注記 / docs/10 リスク2件追記 / README に docs/17-20 への導線。
  docs/15 冒頭に「凍結済み」バナーを追加
- **受入条件**: docs/17 §4 表の「小修正」行が全て解消
