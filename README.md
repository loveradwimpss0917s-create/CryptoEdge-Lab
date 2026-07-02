# CryptoEdge Lab

市場データから未知の Edge (統計的優位性) を発見し、標準化されたプロトコルで検証・ライフサイクル管理する、個人向けクオンツ研究プラットフォーム。

**設計の最優先事項は「月額 ¥0 (Cloudflare Free + GitHub Free) で数年間、毎日動き続けること」** — 性能より持続性 (docs/00 §3-0)。無料枠の予算管理は docs/13 が正典。

**現在の状態**: 設計フェーズ完了 (v2: 無料運用前提へ全面改訂済み)。`docs/` 配下の設計書群が実装の一次入力である。

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

## 実装者向けの読み順

1. `00` を通読 (特に §3 設計原則 — 迷ったらここに従う。原則 0 = 持続性 > 性能)
2. `13` で無料枠の予算と処理配置の正典を頭に入れる (何を Workers に書いてはいけないか)
3. `09` で V1 スコープと Phase を確認
4. Phase 0–1: `01` + `02` + `03` / Phase 2: `05` + `04` / Phase 3: `06` + `07` + `08`
5. 常時: `11` のテスト規約に従う
