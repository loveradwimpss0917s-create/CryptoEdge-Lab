# 01. システム構成 (Architecture)

> 前提: docs/00 §3 の設計原則、特に「Workers に重い計算をさせない」「再現性最優先」。

---

## 1. コンポーネント一覧

| コンポーネント | 実体 | 責務 |
|---|---|---|
| `api` Worker | Cloudflare Workers + Hono | REST API、静的アセット配信 (SPA)、認証、KV キャッシュ制御、AI Gateway 呼出し |
| `ingest` Worker | Cloudflare Workers (Cron Triggers) | データ収集のスケジューリング。Cron → Queue への収集タスク投入 |
| `fetcher` Worker | Cloudflare Workers (Queue Consumer) | 外部 API 呼出し・正規化・D1/R2 書込み・品質検査。リトライ/DLQ 処理 |
| D1 `cryptoedge` | Cloudflare D1 (SQLite) | メタデータ、集計済み時系列、Edge レジストリ、評価結果。詳細 docs/02 |
| KV `CACHE` | Workers KV | API レスポンスキャッシュ、最新値スナップショット、レート制限カウンタ |
| KV `LOCKS` | Workers KV | 分散ロック (ジョブ二重起動防止)、フィーチャーフラグ |
| R2 `cryptoedge-lake` | Cloudflare R2 | データレイク (Parquet/NDJSON)、データセットスナップショット、レポート HTML、モデル成果物 |
| Queues `ingest-tasks` | Cloudflare Queues | 収集タスクのファンアウト (max_retries=3, DLQ 付き) |
| Queues `ingest-dlq` | Cloudflare Queues | 失敗タスクの隔離と記録 |
| Workers AI / AI Gateway | Cloudflare AI Gateway → Claude API (主) / Workers AI (副) | 要約・仮説生成・レポート起草。docs/07 |
| `research-worker` | GitHub Actions (Python 3.12) | EEP 実行、レジーム推定、Discovery スクリーニング、アーカイブ処理 |
| フロントエンド | React 18 + Vite + TypeScript SPA | UI。`api` Worker の Static Assets として配信 |

Pages は使わない (Workers Static Assets に一本化。Cloudflare 自身が Pages から Workers への移行を推奨しており、API と同一 Worker で配信するほうが構成が単純)。

---

## 2. データフロー

### 2.1 収集フロー (常時)

```
Cron Trigger (ingest Worker)
  ├─ "*/1 * * * *"   tier-1m : BTCUSDT 1m OHLCV (直近確定足), プレミアム指数
  ├─ "*/5 * * * *"   tier-5m : funding 現在値, OI, L/S比, DVOL, orderbook スナップ, 清算(集計)
  ├─ "17 * * * *"    tier-1h : 1h OHLCV 確定, funding 履歴, basis, 各取引所横断値
  └─ "23 1 * * *"    tier-1d : 日次オンチェーン, ETF フロー, macro, F&G, trends, COT(週次), カレンダー
        │
        ▼  1 タスク = {source_id, endpoint, window} を Queue に publish
Queues: ingest-tasks
        │  batch (max_batch_size=10, max_wait=5s)
        ▼
fetcher Worker (Queue Consumer)
  1. KV LOCKS で {source_id, window} ロック確認 (二重取得防止)
  2. 外部 API fetch (ソース別アダプタ, docs/03 §7)
  3. スキーマ検証 + 品質検査 (docs/03 §6) → 不合格は dq_issues に記録
  4. 正規化 → D1 UPSERT (集計データ) / R2 append (生データ NDJSON)
  5. KV CACHE の最新値スナップショット更新 (key: latest:{metric})
  失敗 → retry (指数バックオフ, 3 回) → ingest-dlq → dq_issues 記録 + 通知
```

### 2.2 研究フロー (夜間バッチ + オンデマンド)

```
毎日 02:10 UTC: ingest Worker が日次データ確定を確認後、
  GitHub API `repository_dispatch` (event_type: "research-nightly") を送信
        │
        ▼
GitHub Actions: research-worker
  1. R2 から必要 Parquet を取得 (S3 互換 API, 読取専用トークン)
  2. D1 の Edge レジストリ・ジョブキューを Worker API 経由で取得
     (GET /internal/jobs?status=queued — Bearer トークン認証)
  3. 実行内容:
     a. 日次特徴量の再計算・R2 へ Parquet 書出し
     b. レジーム推定の更新 (HMM / ルール)
     c. 全 ACTIVE/PAPER Edge の增分再評価 + 劣化検知 (CUSUM)
     d. ジョブキューにある評価リクエスト (EEP full run) の実行
     e. Discovery スクリーニング (docs/04 §5) — 新候補の統計表を生成
  4. 結果 JSON を POST /internal/results で D1 に還流、
     大きな成果物 (分布・チャート用データ・モデル) は R2 に PUT
  5. 完了通知 → api Worker が AI ブリーフィング生成をトリガ (docs/07 §3)
```

オンデマンド実行: UI から「この Edge を full 評価」→ `eval_jobs` に enqueue → api Worker が `repository_dispatch` (event_type: "research-on-demand") → 同上。1 ジョブ 5–15 分想定。

### 2.3 配信フロー (UI)

```
Browser (SPA)
  → GET /api/v1/... (api Worker)
      1. Cloudflare Access で認証済み (JWT 検証)
      2. KV CACHE ヒット確認 (TTL はエンドポイント別, docs/08 §2)
      3. ミス時 D1 読取り → KV 書込み → 返却
  重い時系列 (チャート用) は R2 の事前計算済み JSON を署名付きで直接配信
```

---

## 3. 二層コンピュートの境界規約

| 処理 | 実行場所 | 根拠 |
|---|---|---|
| データ取得・正規化・UPSERT | fetcher Worker | I/O バウンド。Workers の得意領域 |
| 単純な派生値 (z-score, 移動平均, プレミアム率) | fetcher Worker (取得時) | O(直近N) の逐次計算で軽量 |
| ローリング特徴量の全量再計算 | research-worker | 全履歴スキャンが必要 |
| GARCH / HMM / Change Point / 木モデル / SHAP | research-worker | 科学計算スタック必須 |
| Walk-Forward / CPCV / Permutation / Bootstrap | research-worker | CPU 数分〜数十分 |
| Verdict 判定 (メトリクス→閾値) | research-worker が算出、D1 に保存 | 決定論。結果のみ配信 |
| AI 要約・レポート起草 | api Worker → AI Gateway | API 呼出しのみで軽量 |
| ペーパーシグナルの発火判定 | ingest/fetcher Worker (5分毎) | ADOPT 済み Edge のシグナル式は軽量な閾値式に限定される (docs/05 §9) |

**規約**: Workers 内で 10ms CPU を超えるループ処理を書きたくなったら、それは research-worker の仕事である。

---

## 4. Cloudflare リソース仕様

### 4.1 Workers

| 項目 | 値 |
|---|---|
| プラン | Workers Paid ($5/mo) — Cron 15 分 CPU 上限、Queues、D1 拡張が必要 |
| ルーティング | `api`: カスタムドメイン or workers.dev。`ingest`/`fetcher`: 外部公開なし |
| バインディング (api) | D1 `DB`, KV `CACHE`/`LOCKS`, R2 `LAKE`, AI Gateway, Queue producer (eval_jobs 用), 環境変数: `GITHUB_TOKEN` (dispatch 用, secret), `RESEARCH_API_TOKEN` (secret) |
| バインディング (ingest) | Queue producer `INGEST_TASKS`, D1, KV |
| バインディング (fetcher) | Queue consumer, D1, KV, R2, 外部 API キー各種 (secret) |
| 互換性 | `compatibility_date` 最新、`nodejs_compat` 有効 |

### 4.2 KV 設計

| Key パターン | 値 | TTL |
|---|---|---|
| `latest:{metric}` (例 `latest:funding:binance:BTCUSDT`) | 最新値 JSON `{v, ts, ingested_at}` | なし (上書き) |
| `cache:api:{path_hash}` | API レスポンス | 30s〜1h (エンドポイント別) |
| `lock:{job_key}` | ロックホルダ ID | 120s |
| `flag:{name}` | フィーチャーフラグ | なし |
| `ratelimit:{source_id}:{window}` | 呼出しカウンタ | ウィンドウ長 |

### 4.3 R2 レイアウト

```
cryptoedge-lake/
├── raw/                          # 追記専用の生データ (NDJSON, 日別)
│   └── {source}/{stream}/dt={YYYY-MM-DD}/part-{hhmm}.ndjson.gz
├── curated/                      # research-worker が生成する正規化 Parquet
│   └── {domain}/{table}/dt={YYYY-MM-DD}/data.parquet
│       # domain: market|derivs|onchain|macro|flows|sentiment
├── snapshots/                    # 評価用データセットスナップショット (不変)
│   └── {snapshot_id}/manifest.json + 参照 Parquet のコピー or ハッシュ参照
├── features/                     # 特徴量ストア (docs/04 §3)
│   └── {feature_set_version}/dt={YYYY-MM-DD}/features.parquet
├── artifacts/                    # 評価成果物
│   └── runs/{run_id}/  (equity_curve.json, distributions.json, shap.json, ...)
├── reports/                      # AI 生成レポート・日次ブリーフィング
│   └── briefings/{YYYY-MM-DD}.md / dossiers/{edge_id}/{version}.md
└── models/                       # 学習済みモデル (HMM パラメータ等)
    └── {model_name}/{version}/model.json
```

- `raw/` は削除しない (docs/02 §5 の保持ポリシー参照。低頻度アクセスでもコストは ~$0.015/GB/月)。
- `snapshots/manifest.json` = `{snapshot_id, created_at, tables: [{path, sha256, rows, ts_min, ts_max}]}`。EEP はこの manifest ハッシュを `eval_runs.dataset_hash` に記録する。

### 4.4 D1

- 単一 DB `cryptoedge` (10GB 上限)。docs/02 の容量試算では V1 で ~1.5GB/年 → 高頻度系を R2 へ退避するローテーションで 5 年以上運用可能。
- 読取りは api Worker、書込みは fetcher / internal API のみ。マイグレーションは `migrations/` の連番 SQL を wrangler で適用。

### 4.5 Queues

| Queue | producer | consumer | 設定 |
|---|---|---|---|
| `ingest-tasks` | ingest Worker | fetcher Worker | max_batch_size=10, max_batch_timeout=5s, max_retries=3, DLQ=ingest-dlq |
| `ingest-dlq` | (自動) | fetcher Worker (dlq handler) | dq_issues へ記録し、KV に障害フラグ |

### 4.6 Cron スケジュール (ingest Worker)

| Cron | Tier | 内容 |
|---|---|---|
| `*/1 * * * *` | 1m | 確定 1m 足 (Binance)。V1 では 1m は直近 48h のみ D1 保持 |
| `*/5 * * * *` | 5m | funding 現在値, OI, L/S, DVOL, 清算集計, orderbook スナップ, ペーパーシグナル判定 |
| `17 * * * *` | 1h | 1h 足確定, funding 履歴同期, basis, 取引所横断, KV スナップ整合 |
| `23 1 * * *` | 1d | 日次系全部 (docs/03 §4), 品質日報 |
| `10 2 * * *` | dispatch | research-nightly を GitHub へ dispatch |
| `0 3 * * 0` | weekly | 週次: D1→R2 アーカイブローテーション, COT, バックアップ検証 |

---

## 5. 通信・認証・キャッシュ方式

| 経路 | 方式 |
|---|---|
| Browser → api | HTTPS + Cloudflare Access (Zero Trust, メール OTP)。api Worker は `Cf-Access-Jwt-Assertion` を検証 |
| api → D1/KV/R2 | バインディング (内部) |
| ingest/fetcher → 外部 API | HTTPS。API キーは Worker Secrets。ソース別レートリミッタ (KV カウンタ) |
| api → GitHub | REST `repository_dispatch`、PAT (repo scope) を Secret 管理 |
| research-worker → Cloudflare | R2: S3 互換 API (スコープ限定トークン)。D1: **直接触らない**。api Worker の `/internal/*` (Bearer `RESEARCH_API_TOKEN`) 経由のみ。理由: スキーマ検証・トランザクション・監査ログを一元化 |
| AI | api Worker → AI Gateway → Anthropic API (`claude-sonnet-5`) / フォールバック Workers AI。Gateway でキャッシュ・レート制御・コスト計測 |
| リアルタイム UI 更新 | V1: ポーリング (30s)。V2: SSE (`GET /api/v1/stream`)。WebSocket は不要 (単一ユーザ) |

キャッシュ階層: ブラウザ (SWR, stale-while-revalidate) → KV (30s–1h) → D1。時系列チャートは R2 事前計算 JSON (immutable, `Cache-Control: max-age=31536000` + バージョン付き URL)。

---

## 6. リポジトリ / ディレクトリ構成

pnpm workspaces + Turborepo のモノレポ。research は Python (uv 管理)。

```
CryptoEdge-Lab/
├── docs/                          # 本設計書群 (実装の一次入力)
├── apps/
│   ├── web/                       # React SPA
│   │   ├── src/
│   │   │   ├── app/               # ルーティング (TanStack Router), プロバイダ
│   │   │   ├── screens/           # 画面単位 (docs/06 の SCR-xx と 1:1)
│   │   │   │   ├── today/         # SCR-01 Today (Daily Briefing)
│   │   │   │   ├── edge-board/    # SCR-02
│   │   │   │   ├── edge-detail/   # SCR-03 Dossier
│   │   │   │   ├── discovery/     # SCR-04 Discovery Lab
│   │   │   │   ├── data-health/   # SCR-05
│   │   │   │   ├── reports/       # SCR-06
│   │   │   │   └── settings/      # SCR-07
│   │   │   ├── components/        # 共有 UI (design system, docs/06 §6)
│   │   │   ├── api/               # 型付き API クライアント (openapi-fetch)
│   │   │   ├── lib/               # 日付/フォーマット/統計表示ユーティリティ
│   │   │   └── styles/
│   │   └── vite.config.ts
│   └── api/                       # api Worker (Hono)
│       ├── src/
│       │   ├── index.ts           # エントリ (fetch handler + assets)
│       │   ├── routes/            # docs/08 のリソース単位 (edges.ts, runs.ts, ...)
│       │   ├── middleware/        # access-auth, cache, error, audit
│       │   ├── services/          # ドメインロジック (edge-lifecycle, briefing, ...)
│       │   ├── internal/          # /internal/* (research-worker 用)
│       │   └── ai/                # AI Gateway クライアント, プロンプト (docs/07)
│       └── wrangler.jsonc
├── workers/
│   ├── ingest/                    # Cron スケジューラ Worker
│   │   ├── src/index.ts           # scheduled handler → タスク生成 → Queue publish
│   │   ├── src/schedule.ts        # tier 定義 (docs/03 §5 と 1:1)
│   │   └── wrangler.jsonc
│   └── fetcher/                   # Queue consumer Worker
│       ├── src/index.ts           # queue handler
│       ├── src/adapters/          # ソース別アダプタ (docs/03 §7 と 1:1)
│       │   ├── binance.ts, bybit.ts, okx.ts, deribit.ts, coinbase.ts,
│       │   ├── coinglass.ts, coingecko.ts, defillama.ts, altme-fng.ts,
│       │   ├── fred.ts, etf-flows.ts, etherscan.ts, tronscan.ts,
│       │   ├── coinmetrics.ts, blockchain-info.ts, mempool-space.ts,
│       │   └── hyperliquid.ts, upbit.ts, cftc-cot.ts, calendar.ts
│       ├── src/quality/           # 品質検査ルール (docs/03 §6)
│       ├── src/signals/           # ペーパーシグナル判定 (docs/05 §9)
│       └── wrangler.jsonc
├── packages/
│   ├── schema/                    # 単一の真実: D1 スキーマ型, zod, OpenAPI 生成
│   │   ├── src/db/                # テーブル型 (docs/02 と 1:1)
│   │   ├── src/api/               # リクエスト/レスポンス zod スキーマ
│   │   └── src/domain/            # Edge 状態機械, Verdict 型, レジーム型
│   ├── shared/                    # 定数, 時刻処理 (常に UTC), 軽量統計 (z-score等)
│   └── config/                    # eslint, tsconfig, prettier 共有設定
├── research/                      # Python 研究ワーカー (GitHub Actions で実行)
│   ├── pyproject.toml             # uv, ruff, pytest
│   ├── src/cryptoedge_research/
│   │   ├── io/                    # R2 (s3fs), internal API クライアント
│   │   ├── data/                  # Parquet ローダ, snapshot builder, PIT 整合検査
│   │   ├── features/              # 特徴量定義レジストリ (docs/04 §3 と 1:1)
│   │   ├── regimes/               # HMM, ルールベースレジーム (docs/04 §6)
│   │   ├── discovery/             # スクリーニング, 候補生成文法 (docs/04 §4-5)
│   │   ├── eval/                  # EEP: backtest, costs, wf, cpcv, permutation,
│   │   │   │                      #      bootstrap, metrics, verdict (docs/05 と 1:1)
│   │   ├── decay/                 # CUSUM 劣化検知
│   │   └── jobs/                  # nightly.py, on_demand.py (エントリポイント)
│   └── tests/
├── migrations/                    # D1 SQL マイグレーション (0001_init.sql, ...)
├── .github/workflows/
│   ├── ci.yml                     # lint + typecheck + unit test (TS/Python)
│   ├── deploy.yml                 # main への push で wrangler deploy (3 Workers)
│   ├── research-nightly.yml       # repository_dispatch: research-nightly
│   └── research-on-demand.yml     # repository_dispatch: research-on-demand
├── package.json / pnpm-workspace.yaml / turbo.json
└── README.md
```

**実装規約**:
- `packages/schema` を唯一の型ソースとし、web/api/workers はここから import。D1 スキーマ変更は migrations + schema 同時変更を CI で強制 (docs/11 §5)。
- research (Python) 側の結果 JSON スキーマも `packages/schema/src/api/internal.ts` の zod と契約テストで同期 (docs/11 §4)。
- 全時刻は epoch ミリ秒 (UTC)。文字列日付は `YYYY-MM-DD` (UTC 日付) のみ許可。

---

## 7. 将来の拡張方法

| 拡張 | 方法 | 影響範囲 |
|---|---|---|
| 銘柄追加 (ETH 等) | `instruments` に行追加 + ingest tier 設定。スキーマ変更不要 (全時系列テーブルは instrument_id 軸を持つ) | 収集コスト増のみ |
| 有料データ (Glassnode/CryptoQuant/Amberdata) | fetcher にアダプタ追加 + `data_sources` 登録。curated スキーマは共通 metric 形式 (docs/03 §3) なので下流変更なし | アダプタ 1 ファイル |
| ティック/オーダーブック L2 研究 | R2 に raw websocket 録画を追加する専用 Durable Object (V3)。D1 には集計のみ | workers/recorder 新設 |
| 計算量の増大 | research-worker を GitHub Actions → 任意のコンテナ実行環境 (Cloudflare Containers / 自宅マシン / VPS) に差替え。契約は「R2 読み + /internal API 書き」だけなので移設自由 | workflow 定義のみ |
| リアルタイム推論 | ADOPT Edge のシグナル式は制約付き DSL (docs/05 §9) なので Workers 内評価のまま増やせる | なし |
| マルチユーザ化 (V3+) | Cloudflare Access → 独自認証 + D1 に user_id 列追加。設計上 user 依存データは settings/watchlist のみに隔離してある | 限定的 |
| DB 容量限界 | ドメイン別 D1 分割 (market / research) or 高頻度系の R2 完全移行 + 分析は DuckDB-wasm | docs/12 §4 |
