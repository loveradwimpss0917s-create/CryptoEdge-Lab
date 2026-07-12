# CryptoEdge Lab

市場データから未知の Edge (統計的優位性) を発見し、標準化されたプロトコルで検証・ライフサイクル管理する、個人向けクオンツ研究プラットフォーム。

**設計の最優先事項は「月額 ¥0 (Cloudflare Free + GitHub Free) で数年間、毎日動き続けること」** — 性能より持続性 (docs/00 §3-0)。無料枠の予算管理は docs/13 が正典。

**現在の状態**: V1 (収集・EEP・ライフサイクル・UI・Pack) 本番稼働中。現在は Phase RS
(研究OS化, docs/21)。**ライブの現在地は docs/HANDOFF.md が正典** (本節の詳細記述は保守しない)。
`docs/` 配下の設計書群が実装の一次入力である。

**AIセッションはまずルートの [CLAUDE.md](CLAUDE.md) を読むこと** (読み順・役割・規約への入口)。

## クイックスタート (開発)

```
pnpm install
pnpm exec wrangler d1 migrations apply cryptoedge --local --config apps/api/wrangler.jsonc
pnpm exec wrangler d1 execute cryptoedge --local --config apps/api/wrangler.jsonc --file seeds/0001_pdf_edges.sql
pnpm turbo run typecheck test lint   # 全パッケージ検証
pnpm --filter @cryptoedge/api exec wrangler dev --local   # api Worker (localhost:8787)
pnpm --filter @cryptoedge/web dev                          # web SPA 開発サーバ
cd research && uv sync --extra dev && uv run pytest         # Python 研究パッケージ
```

## 実装済みコンポーネント

| コンポーネント | パス | 内容 |
|---|---|---|
| モノレポ基盤 | `packages/schema`, `packages/shared` | D1 型・DSL・Edge 状態機械・/internal 契約 (TS↔Python 共有ゴールデンフィクスチャ付き) |
| ingest Worker | `workers/ingest` | Cron 4本・D1 タスクキュー・binance/deribit/alternative.me アダプタ・DSL 評価器 |
| api Worker | `apps/api` | Hono API (`/api/v1/*` Cloudflare Access 保護, `/internal/*` Bearer 保護)、Edge ライフサイクルサービス |
| research パッケージ | `research/` | EEP (metrics/walk-forward/permutation/bootstrap/DSR/verdict)・DSL 評価器・ルールベースレジーム分類器 |
| web SPA | `apps/web` | React + Vite + TanStack Router/Query。Today・Edge Board・Edge Dossier |
| PDF シードデータ | `seeds/0001_pdf_edges.sql` | 54 件の Edge 候補 (P0 の 4 件は signal_spec 付き) |

(上記は初期実装時のスナップショット。その後 Explorer・Data Health・Research Readiness・
Feature Store v1・イベントエンジン・`daily_briefing` Pack 等が追加済み — 進捗の正典は
docs/18 §3、ライブ状態は docs/HANDOFF.md)

## 設計書 (実装はここから読む)

| # | ドキュメント | 内容 |
|---|---|---|
| 00 | [Master Plan](docs/00_MASTER_PLAN.md) | 定義・参考資料の批判的分析・設計原則・全体像・用語集 |
| 01 | [Architecture](docs/01_ARCHITECTURE.md) | Cloudflare/GitHub 二層構成・リソース仕様・ディレクトリ構成 |
| 02 | [Database](docs/02_DATABASE.md) | D1 全テーブル・保持期間・バージョン管理 |
| 03 | [Data Sources](docs/03_DATA_SOURCES.md) | データソースカタログ・収集パイプライン・品質管理 |
| 04 | [Edge Discovery](docs/04_EDGE_DISCOVERY.md) | 発見エンジン (特徴量ストア・スクリーニング・レジーム) |
| 05 | [Edge Evaluation](docs/05_EDGE_EVALUATION.md) | 標準評価プロトコル EEP・ライフサイクル状態機械・劣化監視 |
| 06 | [UI/UX](docs/06_UI_UX.md) | 画面一覧・遷移・ワイヤーフレーム・技術選定 |
| 07 | [AI Integration](docs/07_AI_INTEGRATION.md) | AI 活用箇所と禁止箇所・ブリーフィング・仮説生成 |
| 08 | [API Spec](docs/08_API_SPEC.md) | REST API 全エンドポイント |
| 09 | [Roadmap](docs/09_ROADMAP.md) | V1/V2/V3・P0–P3 優先順位・シード Edge 仕様 |
| 10 | [Risks](docs/10_RISKS.md) | リスク一覧と対策 |
| 11 | [Testing](docs/11_TESTING.md) | テスト戦略 (統計エンジン妥当性テスト中心) |
| 12 | [Operations](docs/12_OPERATIONS.md) | 保守・運用・バックアップ (定常コスト ¥0) |
| 13 | [Free Tier Plan](docs/13_FREE_TIER_PLAN.md) | **無料運用の正典**: 全無料枠の予算・処理配置 (Workers/Actions/ブラウザ)・無料API一覧・有料化トリガー |
| 14 | [Edge Pack v1](docs/14_EDGE_PACK_V1.md) | シード Edge 群の spec 化計画とフェーズ |
| 15 | [Roadmap Audit 2026-07](docs/15_ROADMAP_AUDIT_2026-07.md) | 🔒 凍結 (SONNET-1〜8 実行ログの歴史記録) |
| 16 | [Signal/Event Interface](docs/16_SIGNAL_EVENT_INTERFACE.md) | paper trading シグナルとイベントの境界契約 |
| 17 | [Architecture Audit](docs/17_ARCHITECTURE_AUDIT.md) | 実地監査記録 + **ADR 台帳 (§6)** — 設計変更履歴はここ |
| 18 | [Master Roadmap](docs/18_MASTER_ROADMAP.md) | **ロードマップの正典**: Phase 表・DoD |
| 19 | [Sonnet Implementation Plan](docs/19_SONNET_IMPLEMENTATION_PLAN.md) | **タスクの正典**: 実装カード + 実行ログ |
| 20 | [kasotubot Integration](docs/20_KASOTUBOT_INTEGRATION.md) | 執行 bot 連携契約 (S-20 完了までゲート) |
| 21 | [Research OS Design](docs/21_RESEARCH_OS_DESIGN.md) | **現行の構想正典**: 研究OS化の設計レビューと Phase RS |
| — | [AI Development Guide](docs/AI_DEVELOPMENT_GUIDE.md) | **運用規約の正典**: AI役割分担・実装/設計変更ルール・GitHub運用 |
| — | [HANDOFF](docs/HANDOFF.md) | **ライブの現在地** (常に上書き更新される1枚) |

## 実装者向けの読み順

0. **AIセッションは CLAUDE.md → docs/HANDOFF.md → docs/AI_DEVELOPMENT_GUIDE.md** (必須、10分)
1. `00` を通読 (特に §3 設計原則 — 迷ったらここに従う。原則 0 = 持続性 > 性能)
2. `13` で無料枠の予算と処理配置の正典を頭に入れる (何を Workers に書いてはいけないか)
3. `18` §3 で Phase と進捗、`21` で現行の構想を確認 (`09` はバージョン戦略の上位原理)
4. 着手カード (docs/19) の「関連docs」列が指す設計書を読む
5. 常時: `11` のテスト規約に従う
