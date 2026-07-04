# 08. API 仕様 (REST, api Worker)

> ベース: `/api/v1`。認証: Cloudflare Access JWT (全 `/api/*`)。`/internal/*` は Bearer `RESEARCH_API_TOKEN`。
> 形式: JSON。エラーは RFC 9457 Problem Details。ページングは `?cursor=&limit=` (既定 50, 最大 500)。
> リクエスト/レスポンス スキーマは packages/schema の zod が正で、OpenAPI 3.1 を生成して web が型を得る。

## 1. エンドポイント一覧

### Edges / Versions / Runs

| Method Path | 説明 | 備考 |
|---|---|---|
| GET `/edges` | 一覧。`?status=&category=&q=&sort=score` | Board 用。KV 60s |
| POST `/edges` | 作成 (IDEA/CANDIDATE)。body: title, category, hypothesis, rationale, counter_evidence, evidence, origin, finding_id? | 遷移ガード適用 |
| GET `/edges/{id}` | Dossier 集約 (edge + current version + 最新 verdict + 直近5件の run/verdict/`wf:oos`主要指標 `runs[]`、2026-07 レビュー Task 8) | KV 30s |
| PATCH `/edges/{id}` | thesis 系フィールド更新のみ (status は不可) | |
| POST `/edges/{id}/transitions` | 状態遷移。body: to_status, reason。ガード違反 409 | audit 記録 |
| GET `/edges/{id}/versions` / POST 同 | バージョン一覧 / 新バージョン作成 (signal_spec は DSL 検証) | 不変 |
| GET `/edges/{id}/runs` | Run 履歴 (試行数表示の元) | |
| POST `/edges/{id}/eval` | 評価要求。body: version_id, kind(screen/full) → jobs 投入 + dispatch | 202 + job_id |
| GET `/runs/{run_id}` | Run 詳細 (metrics 全 segment + verdict + artifact URL 群) | artifact は R2 署名 URL |
| GET `/edges/{id}/paper-signals` | ペーパー履歴 | |
| GET `/portfolio/correlations` | 相関行列 + クラスタ + 有効独立数 | KV 1h |

### Discovery

| Method Path | 説明 |
|---|---|
| GET `/findings` | `?batch=&status=&min_novelty=&max_q=` |
| POST `/findings/{id}/promote` | Edge 作成へ (body: hypothesis, rationale, ...) |
| POST `/findings/{id}/dismiss` | 却下 (reason 必須) |
| GET `/discovery/config` / PUT 同 | 試行空間設定 (θ グリッド等)。PUT は試行空間サイズを再計算して返す |
| POST `/discovery/explorer-candidates` | Explorer (ブラウザ内 DuckDB) で発見した条件式を次回 weekly スクリーニング候補として保存 |

### Market / Data

| Method Path | 説明 |
|---|---|
| GET `/market/overview` | Today 市況ストリップ (KV latest 集約) |
| GET `/market/candles?instrument=&tf=&from=&to=` | チャート用。長期間は R2 事前計算 JSON へ 302 |
| GET `/metrics/{metric_id}?from=&to=&asof=` | 汎用系列 (asof 指定で PIT ビュー) |
| GET `/events?type=&from=&to=` | イベント |
| GET `/regimes?from=&to=` | レジーム帯 |

### Data Health

**実装状況 (docs/15 SONNET-4, 2026-07)**: 下表の `/health/*` 4本の代わりに `GET /data-health` 1本を
実装した V1 スライス — ソース×ストリームの品質スコア格子と open issues 一覧を1回の呼び出しで返す
(SCR-05 のグリッド表示に必要なのはこの2つだけで、UI側で複数エンドポイントを組み合わせる理由がない)。
品質スコアは docs/03 §6 が定義する「直近30日の取得成功率×欠損なし率」の**近似**——
`ingest_state` は現在の状態1行のみを保持し過去の実行履歴を持たないため、真の30日ローリング値は
計算できない (履歴テーブル追加は将来課題)。代わりに `ingest_state` の
`consecutive_errors`/`last_status`/`watermark_ts` から Readiness (services/readiness.ts) と同じ
「保存せずリード時に都度計算する」方式で近似スコアを出す。`/health/refill`・`/health/sources` PATCH
(手動リフィル・ソース無効化) は新規ミューテーションが必要なため未実装のまま。

| Method Path | 説明 |
|---|---|
| GET `/data-health` | **実装済み**: `{overall_quality_score, sources: [{source_id, name, status, streams: [{stream_id, quality_score, consecutive_errors, open_issues, ...}]}], open_issues: [...]}` (docs/15 SONNET-4) |
| GET `/health/streams` | (未実装、`/data-health` の `sources[].streams` で代替) ingest_state + 品質スコア格子 |
| GET `/health/issues?status=` / POST `/health/issues/{id}/ack` | (未実装、一覧は `/data-health` の `open_issues` で代替。ack は未実装) DQ issues |
| POST `/health/refill` | (未実装) 手動リフィル (body: stream_id, from, to) → jobs |
| GET `/health/sources` / PATCH `/health/sources/{id}` | (未実装) ソース有効/無効 |
| GET `/ops/quota` | 当日の `quota_usage` (resource, value, budget, usage_ratio)。Today 画面の使用率バーの元 (2026-07 レビュー Task 7) |

### Reports / Research Pack (AI ハンドオフ) / Jobs / Settings

**実装状況 (docs/15 SONNET-2, 2026-07)**: `GET /packs/:kind/latest` のみ実装済み — `daily_briefing`
(DB上のkindは`briefing`) 1種類の読み出し専用 V1 スライス。生成は research-worker の
research-daily ジョブが行い (決定論テンプレート、AI 不使用、docs/07 §3)、`POST /internal/ai-outputs`
で登録する。貼り戻しは専用エンドポイントを設けず、literature_import 相当の
JSON (`createEdgeRequestSchema` と同一) を既存の `POST /edges` へ直接渡す設計とした —
新規テーブル・新規スキーマを増やさず既存の Edge 作成経路をそのまま再利用できるため。
下表の `/briefings`・`/packs?kind=&entity=`・`/packs/generate`・`/packs/{id}/response`・`/reports`・
`/actions` は docs/07 のフルスコープ (全 pack_kind、S/M/L サイズ、汎用貼り戻し) 用に設計時点で
定義したままの未実装項目 — 需要が生まれた時点で追加する。

| Method Path | 説明 |
|---|---|
| GET `/packs/:kind/latest` | **実装済み**: 指定kind (`briefing`など) の最新 Research Pack を R2 から読み出して返す (docs/15 SONNET-2) |
| GET `/briefings?date=` / GET `/briefings/latest` | (未実装) ブリーフィング (テンプレ生成, 本文は R2) |
| GET `/reports?kind=` | (未実装) 週次等アーカイブ |
| GET `/packs?kind=&entity=` | (未実装) 生成済み Research Pack 一覧 (docs/07 §2) |
| POST `/packs/generate` | (未実装) body: pack_kind, entity, size(S/M/L) → Pack を同期生成 (テンプレのみ・AI 不使用) して R2 パス返却 |
| POST `/packs/{id}/response` | (未実装) AI 回答の貼り戻し。V1では代わりに既存 `POST /edges` を literature_import 相当の貼り戻し先として使う (docs/15 SONNET-2) |
| GET `/actions` | (未実装) Action Queue (承認待ち遷移 + findings new + DQ open の合成) |
| GET `/jobs?status=` / GET `/jobs/{id}` / POST `/jobs/{id}/cancel` | ジョブ管理 |
| GET `/settings` / PUT `/settings/{key}` | 閾値セット等 (PUT は version インクリメント) |
| GET `/audit?entity=` | 監査ログ |

### Internal (research-worker 専用)

| Method Path | 説明 |
|---|---|
| GET `/internal/jobs?status=queued` | ジョブ取得 (dispatched へ CAS 遷移)。claim の直前に `dispatched` で 60 分超放置されたジョブを `queued` へ自動復帰 (2026-07 レビュー Task 7: Actions 側の異常終了で永久に取り残されるのを防ぐ) |
| POST `/internal/jobs/{id}/status` | running/done/failed 報告 |
| GET `/internal/edge-versions/{id}` | signal_spec/params/cost_model 取得 (EEP 実行に必要) |
| GET `/internal/edges/{id}/trial-count` | 当該 edge の累積 screen+full run 数 (DSR の n_trials 自動取得元、docs/05 §3.7) |
| GET `/internal/events?from=&to=` | `[from, to)` (unix ms) の events を返却 (DSL の `event` ノード評価用) |
| GET `/internal/regimes?from=&to=` | `[from, to]` (YYYY-MM-DD, 両端含む) の regimes_daily を返却。EEP が 1h バー系列へ前方埋め結合 (DSL の `regime` ノード評価用、2026-07 レビュー TASK-1) |
| GET `/internal/backup/tables` | 週次バックアップ対象テーブルのホワイトリスト (docs/12 §3) |
| GET `/internal/backup/dump?table=&after_rowid=&limit=` | 1テーブル分を rowid キーセットでページング取得 (バックアップジョブ専用) |
| POST `/internal/runs` | eval_runs 開始登録 (run_id 採番) |
| POST `/internal/runs/{id}/metrics` | eval_metrics バルク投入 (zod 検証) |
| POST `/internal/runs/{id}/verdict` | verdict 投入 → 遷移提案を actions へ |
| POST `/internal/findings` | discovery_findings バルク投入 |
| POST `/internal/regimes` | regimes_daily 更新 |
| POST `/internal/feature-defs` | feature_defs 台帳更新 (実値は R2、docs/04 §3.1、2026-07 レビュー TASK-2 Feature Store v1) |
| POST `/internal/funding-rates` | funding_rates バルク upsert (data.binance.vision 月次アーカイブからの履歴バックフィル、2026-07 レビュー TASK-3) |
| POST `/internal/deriv-metrics` | open_interest + long_short_ratios バルク upsert (data.binance.vision 日次 `metrics` アーカイブ由来、同一ファイルから両テーブルへ、2026-07 レビュー TASK-3) |
| POST `/internal/liquidations` | liquidations_5m バルク upsert (data.binance.vision 日次 `liquidationSnapshot` アーカイブを 5m バケット集計、2026-07 レビュー TASK-3) |
| POST `/internal/correlations` | edge_correlations 更新 |
| GET `/internal/dq-issues?since=` | オープン中のDQ issueを`since`(unix ms)以降で返却 (daily_briefing Pack のDATA節、docs/15 SONNET-2) |
| GET `/internal/verdicts?since=` | `since`以降に確定したverdictをedge titleと結合して返却 (daily_briefing Pack、docs/15 SONNET-2) |
| GET `/internal/readiness-summary` | `GET /api/v1/edges/readiness-summary`と同じロールアップをBearer認証下で提供 (docs/06 §7.6、docs/15 SONNET-2) |
| POST `/internal/ai-outputs` | 生成済みPack (R2へ書き込み済み) を`ai_outputs`へ登録。旧`briefing-ready`案 (通知→生成の2段階) を置き換え — 生成自体はresearch-worker内で完結する決定論テンプレートのため (docs/07 §3, docs/15 SONNET-2) |

### Lake パススルー (ブラウザ内 DuckDB 用)

| Method Path | 説明 |
|---|---|
| GET `/lake/{path}` | R2 curated/features Parquet の認証付きパススルー (**Range リクエスト対応必須** — DuckDB-WASM が部分読みする)。immutable キャッシュヘッダ |
| GET `/lake/catalog` | 利用可能な Parquet データセットのカタログ (パス・スキーマ・期間) |

## 2. キャッシュ TTL 規約 (**Cache API** — KV はキャッシュに使わない, docs/13 §1)

| パターン | TTL |
|---|---|
| `/market/overview`, `/actions` | 30s |
| `/edges` 一覧, `/findings` | 60s |
| `/edges/{id}` Dossier | 30s (遷移/新 Run で明示 purge) |
| `/portfolio/*`, `/regimes` | 1h |
| Run artifact (R2) | immutable |

## 3. 共通挙動

- 書込み系は `Idempotency-Key` ヘッダ対応 (D1 に 24h 記録 — KV 書込枠を使わない)
- 全書込みは audit_log 記録
- レート制限: 単一ユーザ + Access 前提のため簡易 (D1 カウンタで 300 req/min)
- リアルタイム更新はポーリング (30–60s)。SSE は V2 以降に必要性が実証されてから (docs/01 §5)
