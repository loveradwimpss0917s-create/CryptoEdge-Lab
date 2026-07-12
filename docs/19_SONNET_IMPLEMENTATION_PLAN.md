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

### S-97: UIUX監査 — Board カードが設計 (docs/06 §3) を実装していなかった

- **WHY**: ユーザーから「UIUXが使いにくい」と指摘を受け、docs/06 (UI/UX設計) を参照して
  実装との差分を監査。SCR-02 Edge Board のワイヤーフレーム (docs/06 §3) は
  「カード: title / readiness チップ / score / verdict / 試行数 / スパーク」と明記しているが、
  実際の `EdgeCard` (`EdgeBoardScreen.tsx`) は title / readiness チップ / category / pdf_ref
  のみで、score・verdict・試行数が一切表示されていなかった。docs/06 §1 の中核原則3
  (「統計的誠実さのUI化: 試行回数カウンタをEdgeカードに常時表示」) が未実装だった —
  Board を一覧しても各Edgeの状態が全く分からず、1件ずつ開いて確認する必要があった
  (これが「使いにくい」の実体と判断)
- **WHAT**: `GET /api/v1/edges` に `latest_verdict`/`latest_score`/`trial_count` を
  相関サブクエリで追加 (件数がdozens規模のため許容、docs/13 §1)。`EdgeCard` に
  verdictバッジ (ADOPT/WATCH/REJECT色分け + score) と試行数を追加。
  `VERDICT_BADGE_CLASS` を `EdgeDetailScreen.tsx` からの重複定義を解消し `labels.ts` に集約
  (両画面で共有)
- **DONE/受入条件**: `edges.test.ts` に新規テスト2件 (verdict/score/trial_countが
  正しく返る場合・評価未実施でnull/0になる場合)。`labels.test.ts` は既存4件のまま。
  typecheck/lint/test/build 全緑。Tailwindの実コンパイル済みCSSを使い、長いタイトル・
  各verdict色・試行数0のケースを含む静的HTMLプレビューをPlaywrightでスクリーンショットし、
  バッジの折り返し・重なりが無いことを目視確認済み (実データでの確認は本番Access認証が
  このサンドボックスから通らないため不可、レイアウトの目視確認のみ)
- **関連docs**: docs/06 §1 item 3, §3 SCR-02
- **実行ログ (2026-07-12, Sonnet)**: 実装完了。api 92件・web 8件 green。デプロイ待ち。
  スパーク (paper equity) は対象外 (docs/06 §3 SCR-01 の Portfolio Pulse 未実装と同じ理由 —
  paper_signals の母数がまだ少ない)

### S-98: UIUX監査 — Action Queue が「ゼロインボックス型」を実装していなかった

- **WHY**: S-97 に続けてユーザーから追加のUIUX監査を依頼。docs/06 §1 中核コンセプト1
  「Action Queue: システムが人間に求める意思決定を単一のキューとして常時表示。
  ゼロインボックス型」、および §3 SCR-01 のワイヤーフレームは項目①(承認待ち)に
  `[Dossier を見る] [承認] [却下]` を明示しているが、実際の `ActionQueuePanel`
  (`TodayScreen.tsx`) は全項目が Edge Dossier へのリンクのみで、承認/却下/DQ解決の
  いずれも「一旦別画面に移動してからボタンを押す」必要があった。ゼロインボックスの
  核心 (キュー内で完結) が未実装だった
- **WHAT**: `approval` kind (verdict=ADOPT かつ status=TESTING、単一の決定的アクションが
  存在する唯一のケース) に `[承認]`(→VALIDATED)`[却下]`(→REJECTED) をキュー内に追加。
  `dq` kind に `[解決]` (S-02の既存 `resolveDqIssue` を再利用) を追加。`review` kind
  (SCREEN_DONE、またはFULL_DONEでもverdict≠ADOPT) は単一の正しいアクションが
  存在しない (ワイヤーフレームも要約行のみでボタン無し) ため、クリックスルーのまま
  据え置き — 誤ったデフォルトアクションを機械的に提示しない設計判断
- **DONE/受入条件**: バックエンド `action-queue.ts` の `ActionItem` に `issue_id` を追加
  (dq itemのみ実値、他はnull)。`actions.test.ts` に新規テスト2件。フロントは
  `EdgeCard`と同様、Tailwindの実コンパイル済みCSSで承認/DQ/レビューの3パターンを
  静的HTMLプレビューし、ボタンの配置・折り返しをPlaywrightで目視確認済み
- **関連docs**: docs/06 §1 item 1, §3 SCR-01
- **実行ログ (2026-07-12, Sonnet)**: 実装完了。api 94件 green (新規2件)。
  typecheck/lint/build 全緑。デプロイ待ち

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

## Phase RS: 研究OS化 (S-100〜S-110) — docs/21 の実装カード

> **位置づけ**: docs/21 (Research OS 構想, 2026-07-12) の Phase RS1〜RS4 を実装粒度に
> 展開したもの。設計判断は本節が正 (docs/21 §6-7 は方向性のみ)。
> 実装順は **S-100 → S-101 → S-102** が全後続の前提。S-110 (契約テスト) は独立で随時可。
> Phase R2 (V1.5) の未着手カード (S-08〜S-22) より本節を優先する — 律速は
> アダプタ本数ではなく「1試行あたりコスト」であることが本番実測で確定したため (docs/21 §0)。

### S-100: features parquet に forward return 列を追加 (RS1)

- **WHY**: Explorer (Signal Lab) も Discovery Engine も「feature値と*その後の*リターンの
  関係」を見る道具なのに、features parquet には feature 列しか無く forward return が
  存在しない。これが docs/21 §3 の「Explorer は研究に使えない」の根本原因であり、
  S-101 (IC)・S-106/107 (Signal Lab)・S-108 (Discovery) 全ての前提工事
- **設計判断 (確定)**:
  1. **計算は `eval/backtest.py` の `forward_returns_series()` を再利用する** (新実装禁止)。
     これが EEP 本体と同一の規約 — bar t で signal → t+`entry_delay_bars` の open で entry →
     その `horizon_bars` 後の close で exit — を持つ唯一の実装であり、Signal Lab / Discovery の
     数字と screen/full の数字が「同じ定義のリターン」で照合可能になる
  2. 規約: `entry_delay_bars=1` (docs/00 §3 原則2: 同バー約定禁止)、`direction="long"`、
     **コスト控除なし (gross)**、単位 bps。short や net はビュー側で符号反転/控除すればよい
  3. horizon は `{"1h": 1, "4h": 4, "24h": 24, "72h": 72, "168h": 168}` (1h グリッドの bar 数)。
     列名 `fwd_ret_1h` … `fwd_ret_168h`
  4. **feature_defs には登録しない / registry.py の FEATURES にも入れない**。これは
     feature ではなく教師ラベル (未来を含む)。signal_spec が `fwd_ret_*` を参照した場合、
     未登録ゆえ Readiness が「未定義feature」と判定し、評価器も fail-closed で落ちる —
     この既存挙動そのものが lookahead spec への正しい防波堤なので、例外処理を足さないこと
  5. 後方互換: parquet は features_sync が毎回全量上書きするため migration 不要。
     デプロイ後に lake-sync.yml を workflow_dispatch で1回手動実行して列を反映する
- **WHAT**: `research/src/cryptoedge_research/features/labels.py` 新設
  (`FORWARD_HORIZONS: dict[str, int]` + `compute_forward_labels(candles) -> pd.DataFrame`)。
  `jobs/features_sync.py` の `sync_features_for_instrument()` で `compute_features()` の結果に
  label 列を concat して同一 parquet に書く
- **受入条件**:
  (a) 整合 golden: 合成 candles + 任意の fires に対し `fwd_ret_{h}[t]` ==
  `run_backtest(...)` が bar t の signal に対して返す `Trade.ret_bps` (コスト0設定) と一致。
  (b) lookahead 検査: bar t+1+h の close を摂動すると `fwd_ret_{h}[t]` が変わり、
  `fwd_ret_{h}[t-1]` 以前は変わらないことを assert (実装を1バーずらすと落ちるテスト)。
  (c) NaN tail: 末尾 h+1 行が NaN。
  (d) 本番: lake-sync 手動実行後、Explorer の SQL タブで
  `SELECT ts, ret_24h, fwd_ret_24h FROM ...` が引けること
- **関連docs**: docs/21 §6, docs/04 §3, docs/05 §3.2 (リターン規約)

### S-101: Feature Catalog — description + feature_stats (IC) + カタログAPI/UI (RS1)

- **WHY**: feature 語彙16本が UI のどこにも表示されず、「何が書けるか」を知るのに Python
  ソースを読むしかない (docs/21 P-2)。また S-97/98 同様、docs/06 に設計だけあるカタログ画面が
  未実装。IC (feature×horizon の予測力) はカタログの並び順に使う最重要メタデータ
- **設計判断 (確定)**:
  1. **IC は features_sync.py 内で計算する** (専用 nightly を新設しない)。sync 時点で
     features + fwd_ret の DataFrame が既にメモリ上にあり、Spearman 相関の追加コストは
     数秒。計算場所の選択肢 (api Worker / 新規ジョブ / ブラウザ) はすべて却下 —
     Worker は R2 の parquet を pandas 相当で読めず、新規ジョブは同じ読み込みを二度やる
  2. 保存先は新テーブル `feature_stats` (migration 0009):
     `(feature_id TEXT, horizon TEXT, instrument_id TEXT, spearman_ic REAL,
     q5_q1_spread_bps REAL, n INTEGER, computed_at INTEGER,
     PRIMARY KEY (feature_id, horizon, instrument_id))`。書き込みは
     `POST /internal/feature-stats` (INSERT OR REPLACE、research token 認証は既存踏襲)
  3. 指標定義: `spearman_ic` = feature[t] と fwd_ret_{h}[t] の Spearman 相関
     (両方 non-NaN の行のみ)。`q5_q1_spread_bps` = feature 値で `pd.qcut(5)` した
     最上位分位の平均 fwd_ret − 最下位分位の平均 fwd_ret。n < 500 の組は書き込まない
  4. `readiness.ts` の `DERIV_FEATURE_BASE_TABLE` と `loadSharedContext` 相当の
     データ充足判定をカタログAPIと**共有** (export して再利用。コピー禁止 —
     このハードコード表の二重化は readiness.ts 冒頭コメントが警告済みの負債)
- **WHAT**:
  (1) `features/registry.py`: `FeatureDef` に `description: str` (日本語1行) を追加、16本全てに記述
  (例: `ret_24h`「過去24時間の close 変化率」、`funding_z_30d`「funding rate の30日Zスコア」)。
  `features_sync.py` が `/internal/feature-defs` へ送る `spec` dict に `description` を含める。
  (2) IC 計算 + `internal_client.py` に `FeatureStatInput`/`submit_feature_stats()`。
  (3) api: `GET /api/v1/features/catalog` — feature_defs × feature_stats × データ充足 join。
  応答: `{features: [{feature_id, name, family, description, cadence, lookback_required,
  data_status: "ok"|"data_pending", stats: [{horizon, spearman_ic, q5_q1_spread_bps, n}]}]}`。
  (4) web: `/features` ルート + FeaturesScreen (テーブル、family フィルタ、DATA待ちバッジ、
  IC は符号で色分け、行アンカー `#<feature_id>` — S-105 が使う)。ナビに追加
- **受入条件**: 本番カタログに price 9 + deriv 7 が説明付きで並ぶ。deriv の data_status が
  実データ有無を反映。S-100 反映後の sync 1回で feature_stats が
  16 feature × 5 horizon (n≥500 の組) 埋まり、UI に表示される
- **関連docs**: docs/21 §5-③, docs/06 (カタログ画面), docs/04 §3.1

### S-102: Spec Builder GUI — BoolExpr ツリーエディタ (RS1)

- **WHY**: SignalSpec 手書き JSON が spec 供給 0.8件/日の律速 (docs/21 §0)。DSL は
  7ノードしかない今が GUI 化の適期で、以後の文法拡張 (S-17 dom_in 等) はエディタに
  1ノード足すだけになる
- **設計判断 (確定)**:
  1. **状態管理: SignalSpec JSON オブジェクトそのものを単一の真実とする** controlled
     component (`value`/`onChange`)。ツリー用の別状態表現 (ノードID表・正規化ストア等) を
     **作らない** — 再帰の各段が「子の onChange = 親を immutable に組み直す closure」を
     渡すだけで完結し、JSON との round-trip が構造的に保証される (変換層が無いため)
  2. 構成: `apps/web/src/components/spec-builder/` に
     `SpecBuilder.tsx` (spec 全体: when ツリー + entry.delay_bars + exit (horizon /
     cond+max_horizon 切替) + direction)、`BoolExprEditor.tsx` (再帰ノード、種別 switch)、
     `nodes.ts` (純関数: 種別判定 / デフォルトノード生成 / 種別変換)。
     種別変換は and↔or (子保持)、その他は `{cmp: [{feature: <カタログ先頭>}, ">", 0]}` へ初期化
  3. ノード別フォーム: cmp = feature セレクタ (S-101 カタログ、DATA待ちはバッジ付きで選択可) +
     lag (任意) + 比較子 + 右辺 (数値 | featureRef トグル)。event = type + min_magnitude。
     regime = trend/vol/liquidity の複数選択。time = utc_hour_in / dow_in
     (**dow は Sun=0..Sat=6** — dsl.ts / evaluator.py の規約)。and/or = 子リスト +
     [+条件] ボタン。not = 子1つ
  4. 右ペイン (常時表示): JSON プレビュー + `signalSpecSchema.safeParse` エラー +
     依存チップ (`referencedFeatures`/`referencedEventTypes`/`usesRegime` — schema から
     import、再実装禁止) + カタログ照合による READY 予測 (未定義 feature は赤チップ)
  5. `CreateVersionForm` は [ビルダー | JSON] タブ化。JSON テキストエリアは残し、
     JSON→ビルダー切替時に parse 失敗ならタブ遷移をブロックしてエラー表示。
     safeParse 失敗中は送信ボタン無効
- **受入条件**: (a) 本番の既存 spec 全件 (fixture 化して repo に置く) をビルダーで開き、
  無編集で serialize した結果が deep-equal。(b) `nodes.ts` の単体テスト
  (種別判定7種 / 変換で and↔or の子が保持される)。(c) Playwright で
  「`ret_24h < -3` AND `time.utc_hour_in [0,1]`」を GUI だけで組み、生成 JSON が期待値と
  一致。(d) 無効 spec は送信不可
- **関連docs**: docs/21 §6 (SignalSpec), docs/05 §9, packages/schema/src/domain/dsl.ts

### S-103: literature_import Pack v2 + 取込エンドポイント + Import Studio (RS2)

- **WHY**: 現行の literature_import は「AIに語彙を渡さず JSON を書かせるフォーム」で、
  AI が valid な spec を書けない (docs/21 §3)。①②の実現本体
- **設計判断 (確定)**:
  1. Pack template は**動的生成** `GET /api/v1/packs/literature-import/template`:
     S-101 カタログ (説明・データ充足込み) + DSL 文法解説 (静的定数、7ノードの例つき) +
     カテゴリ enum + 返信 JSON スキーマ + GUARDRAILS (「存在しない feature を参照するなら
     spec_drafts でなく feature_requests に入れよ」) を Markdown で組み立てる
  2. 返信スキーマ `literatureImportV2Schema` (packages/schema/src/api/):
     `{edge: <既存 createEdge と同フィールド>, spec_drafts: [{label: string,
     signal_spec: signalSpecSchema, rationale: string}] (max 5),
     feature_requests: [{name, description, why}]}`
  3. `POST /api/v1/import/literature`: envelope を zod 検証 → edge 作成 (status=IDEA) +
     valid な draft ごとに edge_versions 作成 (semver 0.1.0, 0.2.0, …、is_current は
     最初の valid 案)。**不正な draft はその案だけ拒否し全体をロールバックしない**
     (応答に per-draft の ok/errors を返す — AI 出力の部分的成功を許す設計判断)。
     feature_requests は v1 では**永続化しない** (応答にエコーし UI 表示のみ。
     テーブル化は Discovery 側の feature 需要集計と合流させる将来課題として明記)
  4. 応答に per-draft の readiness (services/readiness.ts を呼ぶ) を含める
- **WHAT**: 上記 + web 新ルート `/import` (ImportStudioScreen):
  [Pack v2 をコピー] → 貼り戻し textarea → 案ごとの結果カード
  (READY/FEATURE待ち/DATA待ちバッジ + [この案を screen] ボタン)
- **受入条件**: サンプル返信 JSON (テストfixture) 1回貼りで Edge 1 + version 3 が入り、
  各案の readiness が返る。draft 2/3 が不正なケースで valid 分のみ登録され、
  エラーが案単位で表示される
- **関連docs**: docs/21 §5-①②, docs/07 §2 (双方向スキーマ), docs/08

### S-104: edge_dossier / improvement Pack (RS2)

- **WHY**: REJECT が行き止まり (docs/21 P-4)。verdict.py の構造化 reasons を
  「次の一手」の AI 相談材料に変換するループの開通
- **設計判断 (確定)**: daily_briefing (research-worker が生成し R2+ai_outputs に保存) と
  違い、この2種は **api Worker がリクエスト時に D1 から決定論生成** し、保存しない
  (`GET /api/v1/packs/edge/:id/dossier` / `.../improvement`)。理由: 内容が Edge の
  現在状態の純関数で、鮮度が命 (保存すると stale 問題が生まれる)。ai_outputs には書かない
- **WHAT**: docs/07 の ROLE/CONTEXT/DATA/QUESTIONS/GUARDRAILS 構成で Markdown 生成。
  dossier = thesis + 現 spec + 最新 full run 全 metrics + verdict reasons + 遷移履歴。
  improvement = dossier 内容 + n_trials (残り試行予算の目安として soft budget 文言) +
  変更候補メニュー (cmp 閾値の近傍、horizon 代替 = S-100 の5種、direction 反転、
  regime/time 条件の追加) を QUESTIONS としてAIに提示。
  UI: EdgeDetail に [Copy for AI: Dossier] 常設、最新 full verdict が REJECT/WATCH のとき
  [Copy for AI: 改善相談] を追加。Action Queue の review アイテムにも後者を出す
- **受入条件**: REJECT 済み「月曜アジア開場効果」で improvement Pack が生成され、
  reasons 全件と試行予算文言が GUARDRAILS に含まれる
- **関連docs**: docs/21 §5-④, docs/07 §2, research/.../eval/verdict.py

### S-105: Readiness Advisor — 不足チップのリンク化 (RS2)

- **WHY**: Readiness が診断名を言うが処方箋を出さない (docs/21 §3、S-95 のユーザー混乱の
  一般化)
- **WHAT**: `labels.ts` のチップ文字列生成をコンポーネント化し、種別ごとに遷移先を付ける:
  未定義/DATA待ち Feature → `/features#<feature_id>` (S-101 のアンカー)、
  イベント/データ待ち → `/data-health` (該当ストリームへアンカー)、
  SignalSpec 無し → EdgeDetail のビルダータブ (S-102) へスクロール + `/import` への導線。
  バックフィル workflow_dispatch の起動ボタンは **S-14 完了までスコープ外**
  (Worker が GitHub token を持たない — 権限設計は S-14 側で行う) と明記
- **受入条件**: DATA_PENDING の Edge から2クリック以内でカタログ該当行 / Data Health
  該当ストリームに着地する
- **関連docs**: docs/21 §5-④, docs/06 §7

### S-106: Signal Lab タブ1 — Feature ランキング (RS3)

- **WHY**: docs/21 §6 Explorer 再設計の第1弾。SQL を書かずに「どの feature に予測力が
  あるか」を一覧できる画面
- **設計判断 (確定)**: 計算は全て DuckDB-WASM (既存 duckdb-lake.ts 経由で features parquet を
  読む)。Spearman IC は SQL で rank() → corr() の2段。SQL 文字列の組み立ては
  `apps/web/src/lib/lab-sql.ts` の純関数に切り出し snapshot テスト。
  **数値の golden はユニットテストでは持たない** (vitest 内で DuckDB-WASM を起動する
  コストが見合わない) — 代わりに受入時に S-101 の feature_stats (Python計算) と
  同一 feature×horizon で突合し ±1e-3 で一致することを実行ログに記録する
- **WHAT**: ExplorerScreen を3タブ化 ([ランキング | ワークベンチ | SQL]、SQL は現行機能を
  無変更で移設)。タブ1: feature×horizon 表 (Spearman IC / Q5−Q1 / n)、年別 IC の
  ミニ表示、feature 行クリックで S-101 カタログへ。ガードレールバナー
  (「この探索は非公式。正式な検定は screen で行われ、試行台帳に記録されます」+
  現在の n_trials — docs/04 の思想の UI 化) を Signal Lab 全タブ共通で表示
- **受入条件**: 16 feature × 5 horizon の表が実 parquet から描画され、feature_stats との
  突合が ±1e-3。SQL タブが従来どおり動く (回帰なし)
- **関連docs**: docs/21 §6, docs/04 §2 (試行の公式/非公式の区別)

### S-107: Signal Lab タブ2 — 条件ワークベンチ + SignalSpec 昇格 (RS3)

- **WHY**: 「安い探索を先に、重い形式化を後に」(docs/21 F-1) を実現する中核。
  条件の表現を SQL でなく BoolExpr にすることで [SignalSpecへ昇格] が1クリックになる
- **設計判断 (確定)**:
  1. 条件エディタは S-102 の `BoolExprEditor` を `allowedKinds` prop 付きで再利用
     (新規エディタ禁止)。v1 で許可: cmp/and/or/not/time。event/regime は parquet に
     列が無いため無効化 (ツールチップで理由表示)
  2. `apps/web/src/lib/boolexpr-sql.ts` 新設: `boolExprToSql(expr): string`。
     cmp の lag は `LAG(<feature>, <lag>) OVER (ORDER BY ts)`、time は
     DuckDB の `date_part` — **dow は Sun=0..Sat=6 に合わせる** (DuckDB `dayofweek` も
     Sun=0 だが、`packages/schema/fixtures/dsl-golden.json` の time ケースを
     そのままテストベクタに使い evaluator との一致を保証すること)。
     未対応ノードは throw (UI 側で事前に無効化済み)
  3. 昇格動線: [SignalSpecへ昇格] → Edge 選択 (既存 Edge or 新規) → EdgeDetail の
     CreateVersionForm へ BoolExpr を prefill (router の navigation state 経由)
- **WHAT**: タブ2 UI: 条件エディタ + horizon 選択 → 条件成立時の fwd_ret 分布 vs 無条件
  (平均/中央値/hit rate/n)、年別テーブル。昇格ボタン
- **受入条件**: `boolexpr-sql.test.ts` が dsl-golden.json の cmp/time/and/or/not ケースを
  網羅 (SQL 実行はせず期待 SQL 文字列 + 手計算の成立行で検証)。
  「ret_24h < -3」条件で分布比較が表示され、昇格で CreateVersionForm に正確な JSON が載る
- **関連docs**: docs/21 §6, docs/05 §9, docs/11 §4 (golden vector 義務)

### S-108: Discovery Engine Stage 1 — 条件付きリターン走査 + BH-FDR (RS4)

- **WHY**: docs/04 §5 Stage 1 の実装。`discovery_findings` テーブルと `/internal/findings`
  だけ存在し書き込むジョブが無い (docs/21 §1.3)。⑥の中核
- **設計判断 (確定)**:
  1. 走査空間 (v1 固定): 16 feature × 4 閾値 (当該 feature の p10/p25/p75/p90 分位点;
     p75/p90 は `>`、p10/p25 は `<`) × 5 horizon (S-100 の FORWARD_HORIZONS)
     = **最大 320 検定/銘柄**。n<100 の組はスキップ
  2. 統計: 条件成立バーの fwd_ret 平均に対する **Newey-West t 検定**
     (Bartlett カーネル、ラグ = horizon_bars — 重複リターンの自己相関補正)。
     p 値は正規近似両側。バッチ全体 (スキップ除く全検定) に **Benjamini-Hochberg FDR** を
     適用し q 値を付与。**q < 0.10 のみ findings として送信**
  3. finding の形: `kind='conditional_return'`、`spec` = BoolExpr JSON
     `{"cmp": [{"feature": <name>}, <op>, <閾値実数>]}` (signalSpecSchema の when として
     そのまま parse 可能であること)、`stats` = `{n, ev_bps, t_nw, p_value, quantile,
     horizon, direction, batch_tests}` (batch_tests = 実施検定総数 — 透明性のため)。
     novelty は v1 では null (既存 Edge との類似判定は Stage 3 以降)
  4. **findings は公式試行ではない** — n_trials 台帳は増やさない (docs/04 の
     公式/非公式の区別)。公式カウントは S-109 で昇格した Edge の screen 時に発生する
  5. 実装構成: 統計は `research/.../discovery/scan.py` の純関数群
     (`newey_west_tstat()`, `bh_fdr()`, `scan_instrument(df) -> list[Finding]`)、
     I/O は `jobs/discovery.py`。workflow は `.github/workflows/discovery.yml`
     (weekly cron + workflow_dispatch — events-backfill.yml の1ジョブ1ワークフロー方式)
- **受入条件**: (a) `bh_fdr()` golden: 事前計算した p 値列→q 値列 fixture
  (statsmodels で offline 生成しコミット) と一致。(b) `newey_west_tstat()` golden:
  小配列で手計算値と一致。(c) 合成データ E2E: 植え込み効果 (feature>p90 で +50bps ドリフト)
  が q<0.10 で検出され、無関係 feature は検出されない。(d) 本番初回実行で findings が
  0件超、全 spec が `signalSpecSchema` の when として parse 可能
- **関連docs**: docs/04 §4-5, docs/21 §5-⑥, migrations/0001 (discovery_findings)

### S-109: Findings Inbox + finding_review Pack + IDEA 昇格 (RS4)

- **WHY**: S-108 の findings を人間+AI のレビューに載せ、経済的接地があるものだけを
  Edge 化する出口 (docs/04 §6 の思想: 統計的異常 ≠ エッジ)
- **設計判断 (確定)**:
  1. API: `GET /api/v1/findings?status=new` (fdr_q 昇順)、
     `POST /api/v1/findings/:id/promote`、`POST /api/v1/findings/:id/dismiss`。
     promote = edges 作成 (status=IDEA、タイトル自動生成「<feature> <op> <閾値> →
     <horizon>」、thesis に stats 要約) + edge_versions 作成 (when=finding.spec、
     exit.horizon=stats.horizon、direction = ev_bps の符号で long/short、is_current=1) +
     finding を status='promoted'/promoted_edge_id 更新。**昇格直後の readiness は
     必然的に READY** (語彙内 feature の cmp のみで構成されるため) — これが受入の要
  2. `finding_review` Pack: S-104 と同じ on-demand 方式
     `GET /api/v1/packs/findings/review` — status=new 上位10件に対し経済的接地の質問
     (「この条件が利益になる*理由*を4源泉 (行動/構造/情報/リスクプレミア) のどれかで
     説明できるか。できなければ dismiss を推奨せよ」) を同梱
  3. UI: Signal Lab に第4タブ [Findings] (docs/06 SCR-04 の実装位置)。
     表 = 条件 (人間可読レンダリング) / ev_bps / q / n / horizon + [昇格][却下] +
     [Copy for AI: review]
- **受入条件**: 昇格した Edge の readiness が READY で、そのまま screen が実行できる。
  dismiss が status を更新し一覧から消える。review Pack に4源泉の質問文が含まれる
- **関連docs**: docs/04 §6, docs/21 §5-⑥, docs/07 §2

### S-110: eval_metrics の metric/segment 名 契約テスト (随時、RS1 相当)

- **WHY**: S-94/S-96 の根本原因 — Python (書き込み) と TS (読み取り) の間に
  metric/segment 名の契約テストが無い。DSL には golden vector があるのに
  eval_metrics には無い非対称の解消 (docs/21 §1.2)
- **WHAT**: `packages/schema/fixtures/eval-metrics-contract.json` 新設 —
  ライフサイクルゲートが読む (segment, metric) ペアの正典リスト
  (`overall/ev_bps`, `wf:oos/p_perm`, `wf:oos/sharpe_bootstrap` 等)。
  (1) TS 側: `edge-lifecycle.ts` の SQL が参照するペアを定数化し、fixture と一致することを
  テスト。(2) Python 側: `run_eep()` の出力 metrics が fixture の全ペアを実際に含むことを
  test_pipeline に追加 (dsl-golden.json と同じ相対パス読み込み方式)
- **受入条件**: fixture からペアを1つ消す/変えると TS・Python 両方のテストが落ちる
- **関連docs**: docs/11 §4, docs/19 S-94/S-96 実行ログ

## S-90: docs 小修正バッチ (随時)

- **WHAT**: docs/17 §4 の「小修正」判定分 — docs/02 列追記 / docs/06 実装済み注記 /
  docs/14 §1.1 件数注記 / docs/10 リスク2件追記 / README に docs/17-20 への導線。
  docs/15 冒頭に「凍結済み」バナーを追加
- **受入条件**: docs/17 §4 表の「小修正」行が全て解消
