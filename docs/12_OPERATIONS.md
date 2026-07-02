# 12. 保守・運用戦略

## 1. デプロイ
- main ブランチ push → GitHub Actions `deploy.yml`: lint/test → `wrangler deploy` (api, ingest, fetcher の 3 Worker) + web ビルド (api の static assets に同梱) + `wrangler d1 migrations apply`
- 環境: `production` のみ (単一ユーザ)。破壊的検証は `wrangler dev` + ローカル D1 で行う。research は git_sha 固定で再現可能なため staging 不要と判断
- ロールバック: Workers は直前バージョンへ即時 rollback 可。D1 は前方マイグレーションのみなので、破壊的変更は「新テーブル追加 → 移行 → 旧テーブル放置」の expand パターンで行う

## 2. 監視・通知

| 対象 | 手段 | 通知 |
|---|---|---|
| 収集健全性 | DQ ルール + 品質スコア (自己監視が本番機能) | critical → メール (MailChannels) / V2: Telegram |
| Worker エラー | Workers Logs + Sentry (無料枠) | 例外急増 |
| Cron 実行 | `ingest_state.last_run_at` の自己ヘルスチェック (tier ごと期待間隔超過で警報) | critical |
| nightly research | 04:00 UTC までに `briefing-ready` が来なければ警報 | critical |
| AI コスト | AI Gateway ダッシュボード + 月次上限 (docs/07 §2) | 80% 到達 |
| コスト全体 | 月次: Workers Paid $5 + R2 ~$1 + AI $5–15 + ドメイン。想定 $15–25/月 | 請求急増 |

## 3. バックアップ・復旧
- D1: 週次 `weekly` Cron で全テーブルを R2 `backups/d1/{date}/` に Parquet エクスポート + Cloudflare の Time Travel (30 日 PITR) を一次手段とする
- R2: バケットのバージョニング有効。raw/ は追記専用で実質不変
- 復旧手順書 (runbook) を `docs/runbooks/restore.md` として実装フェーズで作成: (1) D1 再作成 → migrations → R2 バックアップから COPY (2) KV は再構築可能 (キャッシュのみ) (3) 市場データ穴は watermark リセット + リフィル
- RPO: 市場データ = 0 (再取得可能) / 研究データ = 7 日 (週次) + Time Travel で実質 30 日以内任意点

## 4. 定期保守カレンダー

| 頻度 | 作業 |
|---|---|
| 毎朝 (自動) | DQ 日報、劣化監視、Briefing |
| 週次 (自動) | アーカイブローテーション、バックアップ、live smoke (docs/11 §2)、Edge 相関更新 |
| 月次 (人間 30 分) | コストレビュー、WATCH Edge の再評価キュー確認、依存パッケージ更新 (Renovate PR のマージ)、HMM 再学習結果の確認 |
| 四半期 (人間 2h) | 閾値セット (thresholds.eep) の見直し (変更は新 version として記録)、有料データ費用対効果、D1 容量トレンド、経済カレンダー翌年分シード |
| 年次 | protocol_version 見直し + 全 Edge 一括再評価、Cloudflare/GitHub 料金プラン再評価 |

## 5. 変更管理
- 閾値・コストモデル・レジーム定義の変更は必ず新バージョン発行 (settings versioning) + audit_log。**過去の verdict は書き換えず、新バージョンでの再評価 run を積む**
- 依存更新: Renovate (minor 自動 / major 手動)。research の科学系依存 (numpy/statsmodels/xgboost) は lock 固定し四半期のみ更新 (数値再現性のため。更新時は §11-3 の再現性テストで差分確認)
- ドキュメント: 実装と docs の乖離は PR で同時修正を必須とする (CI で docs 変更なしの schema 変更を警告)

## 6. 長期スケーラビリティ (docs/01 §7 の運用トリガ)
- D1 使用率 > 60% → 高頻度テーブルの保持期間短縮 or ドメイン分割
- nightly > 45 分 → 増分化の徹底 → それでも超過なら research を自前ランナー/Containers へ
- 収集ソース > 30 → fetcher をドメイン別 Worker に分割 (Queue はそのまま)
