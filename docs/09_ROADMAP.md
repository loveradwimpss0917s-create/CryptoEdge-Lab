# 09. 開発ロードマップ・優先順位・将来構想

## 1. バージョン戦略 (ROI 論理)

| Version | テーマ | 価値仮説 (ROI) |
|---|---|---|
| **V1 (MVP, ~8 週)** | 収集 + 標準評価 + シード Edge 検証 + 最小 UI | 最大の ROI は「PDF の P0 5 件を厳密プロトコルで白黒つける」こと。ここまでで日次利用価値が発生 |
| **V2 (+8 週)** | Discovery 自動化 + AI 全面統合 + ポートフォリオ + オプション面 | 発見の量産体制。V1 の運用データが Discovery の検証土壌になる (順序依存) |
| **V3 (以降)** | 高頻度データ録画 + 有料データ + 準リアルタイム + 対話 AI | マイクロ構造系 (PDF カテゴリ A) はデータ蓄積が前提。録画開始が早いほど良いが分析は後回しで可 |

**実装順の根本原理**: データは今日から貯めないと永久に手に入らない (板・清算・funding スナップ)。よって「収集パイプライン」が全機能中最優先 (P0)。逆に UI の磨き込みと AI は後から効く。

## 2. V1 スコープ (フェーズ別)

### Phase 0: 基盤 (P0, 週 1–2)
- モノレポ雛形 / CI / wrangler 設定 / D1 migration 0001 (docs/02 全テーブル) / Cloudflare Access
- packages/schema (テーブル型 + DSL 型 + 状態機械)

### Phase 1: 収集 (P0, 週 2–4)
- ingest/fetcher Worker + Queues + アダプタ第 1 陣: binance_rest, deribit_rest, coinbase_rest, defillama, alternative_me, fred, farside_etf, coinmetrics_community, etherscan/tronscan (USDT mint), yahoo_finance (BTC=F), econ_calendar
- DQ ルール (docs/03 §6) / ingest_state / Data Health API
- バックフィル (docs/03 §5) — research-worker の最初のジョブ

### Phase 2: 評価エンジン (P0, 週 4–6)
- research パッケージ: DSL 評価器 (Py) / EEP full パイプライン (docs/05 §3) / verdict / internal API 連携
- fetcher 側 DSL 評価器 (TS) + ゴールデンテスト一致
- レジーム (ルールベースのみ。HMM は V2)

### Phase 3: シード検証 + UI (P0–P1, 週 6–8)
- PDF 54 件を edges へ一括シード (P0 5 件は edge_version v1 込み: §3)
- P0 5 件の full run 実施 → 初の verdict
- UI: Today (簡易) / Edge Board / Dossier / Data Health。AI はブリーフィング (テンプレ + Sonnet 要約) のみ
- ペーパートレード開始 (ADOPT が出た Edge)

### V1 の Definition of Done
1. 全 tier の収集が 7 日間無人で品質スコア ≥ 99%
2. P0 シード 5 件に protocol_version=1.0 の verdict が付いている
3. 朝のループ (SCR-01) が実データで回る
4. ドキュメント記載の再現性 8 点セット (docs/02 §6) が runs に記録される

## 3. シード Edge の実装仕様 (P0 5 件の signal_spec 要点)

| Edge | signal_spec 要点 | horizon | 判定上の注意 |
|---|---|---|---|
| cme-gap-fill (EC-021) | event: cme_gap (金曜 BTC=F close vs 日曜 spot open, `vol_adj` ギャップ < 2% かつ < $700 相当), direction: ギャップ縮小方向 | fill or 72h | 大サンプル。fill 判定は「ギャップ価格帯タッチ」 |
| utc-2123-drift (EC-018) | time: utc_hour_in [21,22] ∧ regime.trend=up (SMA200 上) | 2h 固定 | データマイニング色が強い → DSR 重視、2020 以降サブサンプル必須 |
| liq-cascade-rebound (EC-006) | cmp: liq_long_z_24h > 3 ∧ oi_chg_24h < −5% | 24–72h long | 清算データ系列の不完全性 (docs/03 §2.4) を counter_evidence に明記 |
| usdt-mint-drift (EC-031) | event: usdt_mint (magnitude ≥ $1B, Treasury→ 外部) | 30m long | 60 分以内限定 (Saggu)。1m 足必要 → 発火監視は 5m Cron + 1m データ |
| vrp-monitor (EC-013) | V1 は Edge 化せず options_surface.vrp の観測ダッシュボードのみ (IDEA 維持) | — | 戦略化 (デルタヘッジ売り) は執行前提が重く V2 で判断 |

## 4. V2 スコープ
- Discovery Engine 全 Stage (docs/04 §5) + Findings Inbox + 試行空間管理 UI
- HMM レジーム / Change Point / CUSUM 劣化検知の自動遷移
- AI: 仮説生成・Dossier ドラフト・DQ 文脈判定・改善提案 (docs/07 §4–5)
- ポートフォリオタブ (相関・有効独立数・限界 Sharpe)
- データ拡張: coinglass 無料枠, bybit/okx, upbit (Kimchi), hyperliquid, cftc_cot, google_trends, options 面の拡張 (RR25/GEX proxy)
- 有料データの費用対効果判定 (運用 3 ヶ月の実績で CryptoQuant/Glassnode を判断)
- SSE / モバイル閲覧最適化 / P1–P2 シードの消化

## 5. V3 スコープ
- WS 録画 Worker (Durable Objects): 板 L2 / aggTrades / forceOrder → R2 (マイクロ構造研究の資産化)
- マイクロ構造 Edge (EC-001/002/005) の研究着手、ETH 横展開 (EC-054)
- ニュース/SNS イベント抽出 (AI)、対話型研究アシスタント (RAG)
- 準リアルタイムシグナル通知 (Push/Telegram)、執行システム連携の設計検討 (別プロジェクト)

## 6. 優先順位マトリクス (P0–P3)

| P | 意味 | 項目 |
|---|---|---|
| **P0** | これが無いと研究が始まらない | 収集パイプライン一式 / D1 スキーマ / バックフィル / EEP full / DSL 評価器×2 / シード 5 件の検証 / Dossier・Board・Data Health 画面 / 再現性 8 点 |
| **P1** | 日次利用の質を決める | Today + Action Queue / ブリーフィング (AI 要約) / ペーパートレード / ルールレジーム / DQ 自動化 / P1 シード評価 |
| **P2** | 発見の量産 | Discovery Stage 1–3 / findings UI / CUSUM / 相関・ポートフォリオ / HMM / AI 仮説生成 / データ拡張群 |
| **P3** | 拡張・研究の幅 | Stage 4–5 (ML/CPD) / WS 録画 / 有料データ / ETH / 対話 AI / SSE / モバイル |

## 7. 見積り注意 (実装者へ)
- 最難関は **EEP の正しさ** (週 4–6)。ここにテスト工数の 50% を割く (docs/11 §3)
- アダプタは 1 本 0.5–1 日 × 11 本。並行可能
- UI は shadcn ベースで Dossier が最重量 (3–4 日)
