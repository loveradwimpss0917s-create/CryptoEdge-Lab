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
| POST `/discovery/import-literature` | テキスト → AI で Edge IDEA ドラフト生成 (202) |

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

### Reports / AI / Jobs / Settings

| Method Path | 説明 |
|---|---|
| GET `/briefings?date=` / GET `/briefings/latest` | ブリーフィング (本文は R2 署名 URL) |
| GET `/reports?kind=` | 週次等アーカイブ |
| POST `/ai/dossier-draft` | body: edge_id → Dossier 文章ドラフト (202) |
| GET `/actions` | Action Queue (承認待ち遷移 + findings new + DQ open の合成) |
| GET `/jobs?status=` / GET `/jobs/{id}` / POST `/jobs/{id}/cancel` | ジョブ管理 |
| GET `/settings` / PUT `/settings/{key}` | 閾値セット等 (PUT は version インクリメント) |
| GET `/audit?entity=` | 監査ログ |

### Internal (research-worker 専用)

| Method Path | 説明 |
|---|---|
| GET `/internal/jobs?status=queued` | ジョブ取得 (dispatched へ CAS 遷移) |
| POST `/internal/jobs/{id}/status` | running/done/failed 報告 |
| POST `/internal/runs` | eval_runs 開始登録 (run_id 採番) |
| POST `/internal/runs/{id}/metrics` | eval_metrics バルク投入 (zod 検証) |
| POST `/internal/runs/{id}/verdict` | verdict 投入 → 遷移提案を actions へ |
| POST `/internal/findings` | discovery_findings バルク投入 |
| POST `/internal/regimes` | regimes_daily 更新 |
| POST `/internal/correlations` | edge_correlations 更新 |
| POST `/internal/briefing-ready` | nightly 完了通知 → AI ブリーフィング生成をトリガ |

## 2. キャッシュ TTL 規約 (KV)

| パターン | TTL |
|---|---|
| `/market/overview`, `/actions` | 30s |
| `/edges` 一覧, `/findings` | 60s |
| `/edges/{id}` Dossier | 30s (遷移/新 Run で明示 purge) |
| `/portfolio/*`, `/regimes` | 1h |
| Run artifact (R2) | immutable |

## 3. 共通挙動

- 書込み系は `Idempotency-Key` ヘッダ対応 (KV に 24h 記録)
- 全書込みは audit_log 記録
- レート制限: ユーザー系 300 req/min (KV カウンタ)、AI 系エンドポイントは 10 req/min
- SSE `/api/v1/stream` (V2): jobs 完了・シグナル発火・DQ critical を push
