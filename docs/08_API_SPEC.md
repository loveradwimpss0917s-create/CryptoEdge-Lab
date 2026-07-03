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
| GET `/edges/{id}` | Dossier 集約 (edge + current version + 最新 verdict + paper 集計) | KV 30s |
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

| Method Path | 説明 |
|---|---|
| GET `/health/streams` | ingest_state + 品質スコア格子 |
| GET `/health/issues?status=` / POST `/health/issues/{id}/ack` | DQ issues |
| POST `/health/refill` | 手動リフィル (body: stream_id, from, to) → jobs |
| GET `/health/sources` / PATCH `/health/sources/{id}` | ソース有効/無効 |
| GET `/ops/quota` | 当日の `quota_usage` (resource, value, budget, usage_ratio)。Today 画面の使用率バーの元 (2026-07 レビュー Task 7) |

### Reports / Research Pack (AI ハンドオフ) / Jobs / Settings

| Method Path | 説明 |
|---|---|
| GET `/briefings?date=` / GET `/briefings/latest` | ブリーフィング (テンプレ生成, 本文は R2) |
| GET `/reports?kind=` | 週次等アーカイブ |
| GET `/packs?kind=&entity=` | 生成済み Research Pack 一覧 (docs/07 §2) |
| POST `/packs/generate` | body: pack_kind, entity, size(S/M/L) → Pack を同期生成 (テンプレのみ・AI 不使用) して R2 パス返却 |
| POST `/packs/{id}/response` | AI 回答の貼り戻し。zod 検証 → ai_outputs (source='handoff') に記録 |
| GET `/actions` | Action Queue (承認待ち遷移 + findings new + DQ open の合成) |
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
| GET `/internal/backup/tables` | 週次バックアップ対象テーブルのホワイトリスト (docs/12 §3) |
| GET `/internal/backup/dump?table=&after_rowid=&limit=` | 1テーブル分を rowid キーセットでページング取得 (バックアップジョブ専用) |
| POST `/internal/runs` | eval_runs 開始登録 (run_id 採番) |
| POST `/internal/runs/{id}/metrics` | eval_metrics バルク投入 (zod 検証) |
| POST `/internal/runs/{id}/verdict` | verdict 投入 → 遷移提案を actions へ |
| POST `/internal/findings` | discovery_findings バルク投入 |
| POST `/internal/regimes` | regimes_daily 更新 |
| POST `/internal/correlations` | edge_correlations 更新 |
| POST `/internal/briefing-ready` | nightly 完了通知 → AI ブリーフィング生成をトリガ |

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
