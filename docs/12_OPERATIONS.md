# 12. 保守・運用戦略

## 1. デプロイ
- main ブランチ push → GitHub Actions `deploy.yml`: **typecheck/test/lint (turbo, 失敗したらデプロイ中断)** → web ビルド → `wrangler d1 migrations apply` → `wrangler deploy` (api, ingest の 2 Worker) → **smoke test (`/api/v1/healthz` が200を返すまで最大5回リトライ、失敗ならワークフローを red にする)**
- 環境: `production` のみ (単一ユーザ)。破壊的検証は `wrangler dev` + ローカル D1 で行う。research は git_sha 固定で再現可能なため staging 不要と判断
- ロールバック: Workers は直前バージョンへ即時 rollback 可。D1 は前方マイグレーションのみなので、破壊的変更は「新テーブル追加 → 移行 → 旧テーブル放置」の expand パターンで行う

### 1.1 デプロイ前チェックリスト: Cloudflare Access 設定 (必須・2026-07 レビューで発見)

`apps/api/wrangler.jsonc` の `vars.ENVIRONMENT` は `"production"` に設定済み。これにより
`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` が未設定の間、`/api/v1/*` への **変異系リクエスト
(POST/PUT/DELETE) は 401 で拒否**される (フェイルクローズ)。GET は Access 設定前でも
閲覧できるが、書き込みを有効にするには以下が必要:

**実運用手順 (2026-07 に実施・検証済み)**: `/internal/*` は research-worker 専用の
Bearer トークン認証 (`requireInternalToken`, docs/08) であり Cloudflare Access の対象
**ではない**。しかし Access アプリケーションの Destination をホスト全体
(`cryptoedge-api.<subdomain>.workers.dev`, path 指定なし) にすると、Access が edge で
`/internal/*` も含めて認証を要求してしまい、research-worker からの `GET
/internal/jobs` 等が JWT 無しで 302 (ログインページへのリダイレクト) を返す
→ `on_demand.py` が JSON パースに失敗して job が failed になる、という事故が起きる
(2026-07 に実際に発生・特定済み)。**そのため Access アプリケーションは 2 つ必要**:

1. Cloudflare Zero Trust ダッシュボード (`one.dash.cloudflare.com`, 通常の dashboard とは別 URL) →
   初回は **Zero Trust Free プラン**を選択 (アップグレード誘導が出ても選ばない)
2. Access controls → Applications → Add an application → **Self-hosted**
   - アプリ①(本体): Destination = `cryptoedge-api.<subdomain>.workers.dev` (path 空欄 = ホスト全体)。
     Policy: Action=`Allow`, Include=Emails で運用者本人のメールアドレス
     (**Apple Private Relay アドレスは OTP メールが届かない/遅延することがある** — 実メールアドレス推奨)
   - アプリ②(internal bypass): Destination = 同ホスト、**Path = `/internal/*`**。
     Policy: Action=`Bypass`, Include=`Everyone`(Bypass は条件必須)
3. アプリ①の Application Audience (AUD) タグを控える — ダッシュボードの「Details」タブや
   Overview 相当の画面に出ない場合があるため、一覧の「…」→ **Copy as JSON** で得られる
   JSON に含まれないこともある点に注意(UI 変更で位置が動きうる。見当たらなければ
   アプリを開き直して各タブを確認する)
4. Cloudflare ダッシュボード (`dash.cloudflare.com`) → Workers & Pages → `cryptoedge-api` →
   Settings → Variables and Secrets に Secret として追加 (Worker への反映は即時、再デプロイ不要):
   - `ACCESS_TEAM_DOMAIN` = `<team-name>.cloudflareaccess.com`
   - `ACCESS_AUD` = アプリ①の AUD タグ
5. 動作確認: ブラウザで本体 URL を開き Access ログイン(OTP)が出ること、ログイン後に
   UI からの評価実行(`POST /api/v1/edges/{id}/eval`)が成功すること、かつ
   `research-on-demand.yml` のログで `GET .../internal/jobs` が 200 (302 ではない) を
   返していることの 3 点を確認する

## 2. 監視・通知

| 対象 | 手段 | 通知 |
|---|---|---|
| 収集健全性 | DQ ルール + 品質スコア (自己監視が本番機能) | critical → **Telegram Bot** (無料) + GitHub Issue 自動起票 |
| Worker エラー | Workers Logs (無料範囲) + dq_issues への例外記録 | 例外急増 → Telegram |
| Cron 実行 | `ingest_state.last_run_at` の自己ヘルスチェック (tier ごと期待間隔超過で警報) | critical |
| daily research | 04:00 UTC までに daily-light 完了報告が来なければ警報 | critical |
| **無料枠ヘッドルーム** | `quota_usage` (docs/13 §7): D1 サイズ/書込、R2、Actions 分数、KV 書込。`GET /api/v1/ops/quota` + Today 画面の使用率バーで常設表示、ingest tick 毎に DQ-10 で自己監視 (2026-07 レビュー Task 7実装済み。**現状は d1_writes のみ計測** — R2/Actions分数/KV は Task4 のR2書込パスができてから追加) | 80% で dq_issues (DQ-10) + Telegram 通知。「自動緩和」(保持期間短縮等) は docs/13 §6 のトリガー表通り手動判断、未自動化 |
| コスト全体 | **定常 ¥0/月** (Cloudflare Free + GitHub Free + Telegram 無料)。課金が発生したらそれ自体が異常 | 課金検知 = 即調査 |

## 3. バックアップ・復旧
- D1: 週次 (weekly-heavy Actions, `jobs.backup`) で全テーブルを R2 `backups/d1/{date}/{table}.parquet` へエクスポート (8 世代ローリング、実装済み 2026-07 レビュー Task 7)。ページングは D1 の `rowid` によるキーセット方式 (`GET /internal/backup/tables` でテーブル一覧、`GET /internal/backup/dump?table=&after_rowid=` で1ページ取得)。世代の刈り込みは日付ディレクトリ単位、当日分は常に残す。D1 Time Travel (Free プランの保持日数は要確認 — 短い前提で週次エクスポートを一次手段とする) と併用
- R2: バケットのバージョニング有効。raw/ は追記専用で実質不変
- 復旧手順書 (runbook) を `docs/runbooks/restore.md` として実装フェーズで作成: (1) D1 再作成 → migrations → R2 バックアップから COPY (2) KV は再構築可能 (キャッシュのみ) (3) 市場データ穴は watermark リセット + リフィル
- RPO: 市場データ = 0 (再取得可能) / 研究データ = 7 日 (週次) + Time Travel で実質 30 日以内任意点

## 4. 定期保守カレンダー

| 頻度 | 作業 |
|---|---|
| 毎朝 (自動) | DQ 日報、劣化監視、Briefing |
| 週次 (自動) | アーカイブローテーション、バックアップ、live smoke (docs/11 §2)、Edge 相関更新、R2 データレイク同期 (`lake-sync.yml`: candles 差分バックフィル、D1 metrics/OI ミラー、regimes_daily バックフィル、スナップショット manifest 更新) |
| 月次 (人間 30 分) | コストレビュー、WATCH Edge の再評価キュー確認、依存パッケージ更新 (Renovate PR のマージ)、HMM 再学習結果の確認 |
| 四半期 (人間 2h) | 閾値セット (thresholds.eep) の見直し (変更は新 version として記録)、有料データ費用対効果、D1 容量トレンド、経済カレンダー翌年分シード |
| 年次 | protocol_version 見直し + 全 Edge 一括再評価、Cloudflare/GitHub 料金プラン再評価 |

## 5. 変更管理
- 閾値・コストモデル・レジーム定義の変更は必ず新バージョン発行 (settings versioning) + audit_log。**過去の verdict は書き換えず、新バージョンでの再評価 run を積む**
- 依存更新: Renovate (minor 自動 / major 手動)。research の科学系依存 (numpy/statsmodels/xgboost) は lock 固定し四半期のみ更新 (数値再現性のため。更新時は §11-3 の再現性テストで差分確認)
- ドキュメント: 実装と docs の乖離は PR で同時修正を必須とする (CI で docs 変更なしの schema 変更を警告)

## 6. 長期スケーラビリティ (docs/13 §6 の有料化トリガー表が正典)
- D1 使用率 > 50% (2.5GB) → 保持期間短縮 (settings 変更のみ) → 恒常化なら Workers Paid 判断
- Actions 月間 > 1,800 分が 3 ヶ月連続 → Permutation/Bootstrap 回数の自動半減 → 自前ランナー判断
- 収集ソース増で tick の 40 fetch 予算超過 → スロット分割 (schedule.ts の表変更のみ) → 限界なら Workers Paid + Queues (tasks.ts の実装差替え, docs/01 §7)
