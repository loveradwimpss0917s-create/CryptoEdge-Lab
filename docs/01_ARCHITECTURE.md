# 01. システム構成 (Architecture) — 無料プラン前提

> 前提: docs/00 §3 の設計原則。**最優先は「Cloudflare Free + GitHub Free だけで数年間、毎日動き続けること」**。
> 無料枠の数値・予算管理は docs/13 に集約。本書は構成と責務分離を定義する。
> 無料枠の上限値は実装開始時に必ず公式ドキュメントで再確認すること (プラン改定リスク: docs/10 R-P1)。

---

## 1. 三層コンピュートモデル (無料運用の骨格)

性能ではなく「どこなら無料で計算できるか」で処理を配置する。

| 層 | 実体 | コスト | 担当 |
|---|---|---|---|
| **常駐層** | Cloudflare Workers (Free) | ¥0 | データ収集、API 配信、軽量派生値、ペーパーシグナル判定 (閾値式のみ) |
| **バッチ層** | GitHub Actions (Free) | ¥0 | 全統計解析 (EEP/WF/Bootstrap/Permutation/SHAP/HMM)、Parquet 圧縮・アーカイブ、バックアップ |
| **ブラウザ層** | 利用者の PC (DuckDB-WASM) | ¥0 | 対話的な深掘り分析、アドホック集計、チャート描画、AI ハンドオフ資料の組立て |

**なぜこの 3 層か**:
- Workers Free は CPU 10ms/呼出しのため統計計算は物理的に不可能 → 重い処理は「リアルタイム性が不要」という性質を利用して Actions (分単位の CPU が無料) へ逃がす
- 「研究者が画面を見ながら行う探索」はレイテンシ要求が高いが、**計算資源は研究者自身の PC が無料で持っている** → R2 の Parquet を DuckDB-WASM で直接読む (R2 は egress 無料なのでこのパターンが成立する)
- AI は常駐させない。バッチ層が「AI に渡せる資料 (Research Pack)」を生成し、研究者が必要時に Claude/ChatGPT/Gemini へ持ち込む (docs/07)

## 2. コンポーネント一覧

| コンポーネント | 実体 | 責務 |
|---|---|---|
| `api` Worker | Workers Free + Hono + Static Assets | REST API、SPA 配信 (静的アセット配信は無料枠のリクエスト数に**カウントされない**)、Cache API によるレスポンスキャッシュ |
| `ingest` Worker | Workers Free (Cron Trigger 1 本 — アカウント全体 5 本上限を他プロジェクトと共有) | 収集の実行本体。Cron tick 内で「タスク表の消化 → 外部 fetch → 正規化 → D1/R2 書込み」まで完結 (**Queues は有料専用のため使わない**)。1h/1d/週次の粒度は壁時計判定 (schedule.ts `tiersForTick`) で内製 |
| D1 `cryptoedge` | D1 Free (5GB, 読取 5M 行/日, 書込 100K 行/日) | メタデータ、集計時系列、Edge レジストリ、評価結果、**タスクキュー表** (Queues の代替)、最新値スナップ (KV の代替) |
| KV `CONFIG` | KV Free (書込 1,000/日 — 制約強) | フィーチャーフラグ・少数の設定のみ。**高頻度書込みは一切置かない** |
| R2 `cryptoedge-lake` | R2 Free (10GB, egress 無料) | データレイク (Parquet)、Run 成果物、Research Pack、バックアップ |
| Cache API | Workers 標準 (無料・無制限) | API レスポンスキャッシュ (KV の代替。エッジローカルだが単一ユーザには十分) |
| `research-worker` | GitHub Actions (private repo: 2,000 分/月) | daily-light (毎日 ~10 分) + weekly-heavy (週 1 ~90 分) + on-demand (workflow_dispatch) |
| フロントエンド | React SPA + DuckDB-WASM | UI + ブラウザ内分析エンジン |
| 通知 | Telegram Bot API (無料) + GitHub Issues (無料) | critical 通知は Telegram、DQ インシデントは Issue 自動起票 (メール送信 SaaS は使わない) |

**旧設計からの削除**: Cloudflare Queues (有料専用) / AI Gateway 常時利用 / MailChannels / Workers Paid 前提の全項目。

## 3. データフロー

### 3.1 収集フロー (ingest Worker, Queues なし版)

```
Cron Trigger 1 本 "*/5 * * * *" (アカウント全体で他プロジェクトと共有する
Free 上限 5 本のうち 1 本のみ使用 — 残りの粒度は壁時計判定で内製)
  ├─ 毎 tick          tick-5m  : ①D1 タスク表のリトライ消化 → ②当該 tick 担当ソースの fetch
  │                              (1m 足は 5 分毎に直近 5 本まとめ取り — 1 分 Cron は不要)
  ├─ 毎時 :15         tick-1h  : 1h 足確定, funding 履歴, basis, オプションサマリ
  ├─ 01:20 UTC        tick-1d  : 日次系 G1→G2→G3 (docs/03 §4), 品質日報, latest 整合
  └─ 日曜 03:00 UTC   tick-wk  : 週次系 (COT, Trends), Actions への weekly dispatch
```

Queues の代替 = **D1 タスク表 `ingest_tasks`** (docs/02 §2.1):
1. tick は最初に `ingest_tasks` から `next_attempt_at <= now` の失敗タスクを最大 N 件消化 (指数バックオフは next_attempt_at で表現、attempts ≥ 5 で dead 状態 → dq_issues)
2. 続いて当該 tick の定常収集を実行。**外部 fetch は 1 tick あたり 40 本以下** (Free の 50 サブリクエスト/呼出し制限に対する 80% 予算)。ソースは 5 分スロットに静的に割り付ける (workers/ingest/src/schedule.ts で宣言的に定義)
3. 失敗した fetch は `ingest_tasks` に登録して即座に次へ (tick を止めない)
4. 正規化 → D1 バッチ UPSERT (1 クエリで複数行)。生レスポンスは R2 `raw/` に**無圧縮 NDJSON** で PUT (10ms CPU 制約下で gzip しない。圧縮は weekly Actions の仕事)

**なぜ成立するか**: 収集は I/O 待ちが支配的で CPU をほぼ使わない (JSON parse 数 KB は <1ms)。Cron 呼出し回数は 288+24+1+1 ≈ 314 回/日で、リクエスト無料枠 (100K/日) の 0.3%。

### 3.2 研究フロー (GitHub Actions)

```
[daily-light]  ingest tick-1d 完了後、Worker が repository_dispatch (研究: 毎日 ~10分)
   - 特徴量の増分計算 (前日分のみ) → R2 features/
   - ACTIVE/PAPER Edge の CUSUM 劣化チェック・paper vs OOS 乖離
   - Research Pack (日次ブリーフィング .md) のテンプレート生成 → R2 reports/
   - 結果を POST /internal/* で D1 へ還流
[weekly-heavy] 週 1 (~90分)
   - Discovery スクリーニング全 Stage (docs/04 §5)
   - Edge 相関・ポートフォリオ統計 / HMM 更新 (月 1)
   - R2 コンパクション: raw NDJSON → gzip Parquet 化・raw 削除 (90 日超)
   - D1 → R2 バックアップ / アーカイブローテーション
[on-demand]    workflow_dispatch / UI からの評価要求 (EEP full, 1 Edge ~10-15分)
```

- スケジュールは **Worker からの repository_dispatch を正**とする (GitHub の schedule トリガーは遅延・スキップがあるため信頼しない。schedule は保険として併設)
- 分数予算: daily 10分×30 + weekly 90分×5 + on-demand 15分×20 + CI ≈ **1,200 分/月 < 2,000 分** (docs/13 §3)。リポジトリを public にすれば標準ランナー分数は無制限になるが、研究内容の秘匿を優先して private 前提で予算設計する

### 3.3 配信・分析フロー (ブラウザ層)

```
SPA (api Worker の Static Assets — リクエスト無料)
 ├─ 軽量 API: /api/v1/* → Cache API → D1  (Board/Dossier/Today 等の定型ビュー)
 └─ 深掘り分析: DuckDB-WASM が R2 の Parquet を HTTP Range 読み
     - R2 は api Worker 経由のパススルー (/lake/*, 認証付き) で配信。egress 無料
     - 用途: 任意条件の分布・層別・相関のアドホック探索 (Discovery Lab の対話部分)、
             チャート用集計、CSV/Markdown エクスポート生成
```

**なぜ**: 「サーバで事前計算した固定ビュー + ブラウザで自由探索」の分担により、Workers の CPU 制約と D1 読取り枠を消費せずに研究の自由度を確保する。数十万行の Parquet スキャンは現代のブラウザ + DuckDB-WASM で 1 秒未満。

## 4. Cloudflare リソース仕様 (Free)

### 4.1 Workers

| 項目 | 値 |
|---|---|
| プラン | **Free** (リクエスト 100K/日・CPU 10ms/呼出し・サブリクエスト 50/呼出し) |
| Worker 数 | 2 (`api`, `ingest`)。fetcher は ingest に統合 (Queues 廃止に伴い分離の意味がない) |
| Cron | ingest に 1 本 (§3.1)。アカウント全体の Free 上限 5 本を他プロジェクトと共有するため、1h/1d/週次は壁時計判定で内製 |
| バインディング (api) | D1, KV `CONFIG`, R2, Static Assets。Secrets: `RESEARCH_API_TOKEN`, `GITHUB_PAT` (dispatch), `TELEGRAM_BOT_TOKEN` |
| バインディング (ingest) | D1, KV, R2。Secrets: 外部 API キー (FRED, Etherscan 等の無料キー) |
| 規約 | 1 呼出しで 10ms CPU を超えうる処理を書かない (レビュー観点として明文化)。バッチ UPSERT は 1 文で多行。ソート/集計は SQL に寄せる |

### 4.2 D1 (Free: 5GB / 読取 5M 行/日 / 書込 100K 行/日)

- 書込み予算: 定常 ~15K 行/日 (docs/13 §2.2 に内訳)。上限の 15%
- 読取り予算: 単一ユーザ UI + internal API で余裕。**Actions は時系列を D1 から読まず R2 Parquet から読む** (読取り枠の温存と再現性の両立)
- バックフィルは 80K 行/日以下にスロットリングし数日かけて流す (docs/03 §5)

### 4.3 KV (Free: 書込 1,000/日) — 役割を最小化

| 用途 | 可否 | 代替 |
|---|---|---|
| フィーチャーフラグ・設定 | ✅ (書込 <20/日) | — |
| 最新値スナップショット (5 分毎更新) | ❌ 2,880 書込/日で枠超過 | D1 `latest_snapshots` テーブル (docs/02 §2.1) |
| API レスポンスキャッシュ | ❌ 読み書き频度が高い | **Cache API** (無料・無制限) |
| 分散ロック | ❌ | D1 (単一 DB なので `INSERT OR IGNORE` で足りる) |

### 4.4 R2 (Free: 10GB / Class A 1M/月 / Class B 10M/月 / egress 無料)

```
cryptoedge-lake/
├── raw/{source}/{stream}/dt=*/part-*.ndjson        # 無圧縮 (Worker 書き)。90日で Parquet 化後削除
├── curated/{domain}/{table}/dt=*/data.parquet      # zstd Parquet (Actions 書き)。永続
├── features/{version}/...  snapshots/...  artifacts/runs/{run_id}/...
├── packs/                                          # AI ハンドオフ用 Research Pack (docs/07)
├── reports/briefings/...   backups/d1/{date}/...
└── models/...
```

- 容量予算: 定常 ~1.2GB/年 (Parquet zstd)。10GB で 6–7 年 (docs/13 §2.3)。raw の 90 日削除と Parquet 化を weekly Actions が実施
- Class A (書込) 予算: ingest の raw PUT ≈ 3,500/日 ≈ 105K/月 (上限の 10%)

### 4.5 通知 (無料 SaaS のみ)

| 経路 | 用途 | 理由 |
|---|---|---|
| Telegram Bot (sendMessage) | critical (収集停止・劣化警報・quota 80%) | 無料・即時・モバイル到達。Bot 作成のみで SaaS 契約不要 |
| GitHub Issues (API 起票) | DQ インシデントの台帳化 | 無料。ラベル・クローズで運用でき、モバイル GitHub アプリでも見える |
| UI Action Queue | すべて | 通知に依存しない一次面 (docs/06) |

## 5. 通信・認証・キャッシュ方式

| 経路 | 方式 |
|---|---|
| Browser → api | HTTPS + **Cloudflare Access (Zero Trust Free — 50 ユーザまで無料)**。JWT 検証 |
| api ↔ D1/KV/R2 | バインディング (サブリクエスト制限に含まれない内部呼出し) |
| ingest → 外部 API | HTTPS。無料キーは Secrets。1 tick 40 fetch 予算 + ソース別スロット割付け |
| api → GitHub | repository_dispatch (PAT, repo scope 最小) |
| research-worker → Cloudflare | R2: S3 互換 API (読み書きスコープ限定トークン)。D1: `/internal/*` (Bearer) 経由のみ — 旧設計と同じ規約 |
| キャッシュ | ブラウザ SWR → **Cache API** (エッジ) → D1。Parquet/成果物は immutable URL |
| リアルタイム | ポーリング 30–60s のみ (単一ユーザ・無料枠では SSE 常時接続の価値が薄い)。V2 でも必要性を再評価してから |

## 6. リポジトリ / ディレクトリ構成

旧版から: `workers/fetcher` を `workers/ingest` に統合、`apps/api/src/ai/` を `packs/` (Research Pack 生成) に置換、web に `duckdb/` を追加。

```
CryptoEdge-Lab/
├── docs/
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── app/  screens/ (SCR-01..07)  components/  api/
│   │       ├── duckdb/            # DuckDB-WASM 初期化, Parquet カタログ, クエリ部品
│   │       ├── packs/             # AI ハンドオフ資料のクライアント組立て・コピー UI
│   │       └── lib/  styles/
│   └── api/
│       └── src/
│           ├── index.ts  routes/  middleware/ (access-auth, cache, error, audit)
│           ├── services/          # edge-lifecycle, actions, briefing-assemble
│           ├── internal/          # /internal/* (research-worker 用)
│           ├── packs/             # Research Pack テンプレート (Markdown 生成, AI 不使用)
│           └── notify/            # telegram.ts, github-issues.ts
├── workers/
│   └── ingest/
│       └── src/
│           ├── index.ts           # scheduled handler (tick ルータ)
│           ├── schedule.ts        # tick→ソース割付け表 (5分スロット静的定義)
│           ├── tasks.ts           # D1 タスク表の enqueue/drain (Queues 代替)
│           ├── adapters/          # docs/03 §7 (旧 fetcher から移動, 契約同一)
│           ├── quality/           # DQ ルール
│           └── signals/           # ペーパーシグナル判定 (DSL 閾値式)
├── packages/
│   ├── schema/                    # D1 型, zod, DSL, 状態機械, /internal 契約 (単一の真実)
│   ├── shared/                    # UTC 時刻, 軽量統計, 定数
│   └── config/
├── research/                      # Python (uv)。構成は旧版どおり (io/data/features/regimes/
│   │                              #  discovery/eval/decay/jobs) + packs/ (Research Pack 生成)
│   └── src/cryptoedge_research/
├── migrations/
├── .github/workflows/
│   ├── ci.yml  deploy.yml
│   ├── research-daily.yml         # repository_dispatch: research-daily (+schedule 保険)
│   ├── research-weekly.yml        # repository_dispatch: research-weekly (+schedule 保険)
│   └── research-on-demand.yml     # workflow_dispatch + repository_dispatch
└── package.json / pnpm-workspace.yaml / turbo.json
```

## 7. 有料化への拡張経路 (設計段階から用意する差込み口)

**原則: 無料構成は「暫定」ではなく正式な V1 アーキテクチャ**。ただし以下の界面を最初から抽象化しておくことで、規模拡大時にコード書換えなしで有料リソースへ移行できる。

| 将来の有料化 | 差込み口 (V1 で用意) | 移行作業 |
|---|---|---|
| Workers Paid (CPU 5 分/Cron, Queues) | `tasks.ts` のインターフェイス (enqueue/drain) | 実装を D1 表 → Queues に差替えるのみ |
| D1 拡張 (10GB+) | 保持期間は `metric_defs.retention_days` と settings で宣言的 | 設定値の変更のみ |
| R2 有料 (10GB 超) | 容量監視 (docs/13 §4) が閾値で警告 | 課金を有効化するだけ (同一バケット) |
| 有料 API (CryptoQuant/Glassnode/CoinGlass) | アダプタ 5 点セット (docs/03 §7)。metric_defs は予約登録済み | アダプタ 1 ファイル追加 |
| AI API 常時利用 (ブリーフィング自動彩色) | Research Pack は構造化 JSON+MD で機械可読。`packs/` の出力を LLM API に流すだけの optional module | docs/07 §6 |
| Vectorize (文献・Dossier の意味検索) | 文書はすべて R2 に Markdown で正規蓄積済み (embedding 対象がきれいに揃っている) | インデクサ Job 追加 |
| 自前ランナー/Containers (解析増強) | research は「R2 読み + /internal 書き」契約のみ | 実行環境の載せ替え |
| ブラウザ分析の限界超過 | DuckDB-WASM のクエリ部品はサーバ版 DuckDB と同一 SQL | Actions/コンテナで同一 SQL を実行 |
