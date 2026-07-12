# 09. 開発ロードマップ・優先順位・将来構想

> **役割注記 (docs/17 ADR-4)**: 本書は「バージョン戦略と優先原理」の上位文書。タスク粒度の
> ロードマップ正典は docs/18、実装カードは docs/19、現行の構想は docs/21 を見ること。

## 1. バージョン戦略 (無料ファースト)

| Version | テーマ | コスト | 移行条件 |
|---|---|---|---|
| **V1 (~8 週)** | **完全無料で全機能が成立** — 収集 + EEP + シード検証 + Discovery 基礎 + ハンドオフ AI | **¥0/月** | — (これが正式な恒常運用形態。V2 が来なくても数年動く) |
| **V2** | データ量・研究量が増えて**必要になった項目だけ**有料化 | 必要分のみ ($5–50/月) | docs/13 §6 のトリガー表が成立した項目のみ、個別に契約 |
| **V3** | さらに規模が大きくなればクラウド強化 (ティック録画・専用ランナー・準リアルタイム) | 判断時に見積り | V2 運用実績が投資を正当化した場合のみ |

**ROI の根本原理 (変更なし)**: データは今日から貯めないと永久に手に入らない → 収集パイプラインが最優先。加えて (v2 方針): **固定費ゼロは「研究を止めない」ための機能である**。ランニングコストがあるとプロジェクト中断=損失になるが、¥0 なら休止も再開も自由 — 個人研究の長期継続性そのもの。

## 2. V1 スコープ (フェーズ別, すべて無料枠内)

### Phase 0: 基盤 (P0, 週 1–2)
- モノレポ雛形 / CI / wrangler 設定 / D1 migration 0001 (docs/02 全テーブル — ingest_tasks, latest_snapshots, quota_usage 含む) / Cloudflare Access (Free)
- packages/schema (テーブル型 + DSL 型 + 状態機械 + /internal 契約)
- **quota 監視の骨格** (docs/13 §7) — 最初から入れる。後付けすると枠超過で気付く羽目になる

### Phase 1: 収集 (P0, 週 2–4)
- ingest Worker (Cron 4 本 + tick スロット割付け + ingest_tasks リトライ) + アダプタ第 1 陣: binance_rest, deribit_rest, coinbase_rest, defillama, alternative_me, fred, farside_etf, coinmetrics_community, etherscan/tronscan (USDT mint), yahoo_finance (BTC=F), econ_calendar
- DQ ルール / Data Health API / Telegram・GitHub Issues 通知
- バックフィル (research-worker 初ジョブ。R2 主体 + D1 80K 行/日スロットリング)

### Phase 2: 評価エンジン (P0, 週 4–6)
- research パッケージ: DSL 評価器 (Py) / EEP full / verdict / internal API 連携
- ingest 側 DSL 評価器 (TS) + ゴールデンテスト一致
- ルールベースレジーム / workflows (daily-light, weekly-heavy, on-demand) + 分数計測

### Phase 3: シード検証 + UI (P0–P1, 週 6–8)
- PDF 54 件シード投入、P0 5 件 (docs/09 §3) の full run → 初 verdict
- UI: Today / Edge Board / Dossier / Data Health + **Research Pack 生成と [Copy for AI] / 貼り戻し** (docs/07)
- Explorer (DuckDB-WASM) の最小版: カタログ + 条件式 + 分布図
- ペーパートレード開始

### V1 の Definition of Done
1. 全 tier の収集が 7 日間無人で品質スコア ≥ 99%
2. **7 日間の quota_usage 実測がすべて docs/13 §1 の予算内** (無料運用の実証)
3. P0 シード 5 件に verdict / 朝のループが実データで回る / 再現性 8 点 (docs/02 §6) 記録
4. daily_briefing Pack を Claude に貼って解析できる (ハンドオフの実証)

## 3. シード Edge の実装仕様 (P0 5 件) — 変更なし

| Edge | signal_spec 要点 | horizon | 注意 |
|---|---|---|---|
| cme-gap-fill (EC-021) | event: cme_gap (BTC=F 金曜 close vs 日曜 spot open, vol_adj < 2% かつ < $700 相当), ギャップ縮小方向 | fill or 72h | 大サンプル。fill 判定 = ギャップ価格帯タッチ |
| utc-2123-drift (EC-018) | time: utc_hour_in [21,22] ∧ trend=up (SMA200 上) | 2h | DSR 重視、2020 以降サブサンプル必須 |
| liq-cascade-rebound (EC-006) | liq_long_z_24h > 3 ∧ oi_chg_24h < −5% | 24–72h long | 清算系列の不完全性を counter_evidence に明記 |
| usdt-mint-drift (EC-031) | event: usdt_mint (≥ $1B) | 30m long | 60 分以内限定 (Saggu)。監視は 5m tick |
| vrp-monitor (EC-013) | V1 は options_surface.vrp の観測のみ (IDEA 維持) | — | 戦略化は V2 判断 |

## 4. V2 スコープ (機能拡張 + 条件付き有料化)

**無料のまま追加する機能**:
- Discovery Engine 全 Stage (docs/04 §5) + Findings Inbox + 試行空間管理 UI
- HMM レジーム / Change Point / CUSUM 自動遷移 / ポートフォリオタブ (相関・有効独立数・限界 Sharpe)
- データ拡張 (無料枠): bybit/okx, upbit (Kimchi), hyperliquid, cftc_cot, google_trends, CoinGlass 無料枠, オプション面拡張 (RR25/GEX proxy)
- Explorer 強化 (層別・保存済みクエリ)、P1–P2 シード消化

**トリガー成立時のみ有料化** (docs/13 §6 の表が正典): Workers Paid / CoinGlass 有料 / CryptoQuant/Glassnode / `ai-autopilot` (Pack の API 自動処理) / Vectorize。**「V2 になったから課金する」のではなく「トリガーが成立した項目だけ課金する」**。

## 5. V3 スコープ (クラウド強化)
- WS 録画 (板 L2 / aggTrades / forceOrder) — Workers Paid + Durable Objects または自宅常駐機。マイクロ構造 Edge (EC-001/002/005) と ETH 横展開 (EC-054)
- 専用ランナー/Containers での解析増強 (Actions 分数の限界超過時)
- ニュース/SNS イベント抽出、対話型研究アシスタント (RAG)、準リアルタイム通知強化
- マルチユーザ化の再評価 (共有 = 投資助言該当性の再検討込み, docs/10 R-J3)

## 6. 優先順位マトリクス (P0–P3)

| P | 意味 | 項目 |
|---|---|---|
| **P0** | 無いと研究が始まらない | 収集一式 / D1 スキーマ / quota 監視 / バックフィル / EEP full / DSL 評価器×2 / シード 5 件検証 / Dossier・Board・Data Health / Research Pack + Copy for AI / 再現性 8 点 |
| **P1** | 日次利用の質 | Today + Action Queue / テンプレブリーフィング / ペーパートレード / ルールレジーム / Telegram 通知 / Explorer 最小版 / P1 シード |
| **P2** | 発見の量産 | Discovery Stage 1–3 / findings UI / CUSUM / 相関・ポートフォリオ / HMM / 無料データ拡張 / 貼り戻しスキーマの拡充 |
| **P3** | 拡張 | Stage 4–5 (ML/CPD) / 有料化トリガー項目 / WS 録画 / ETH / RAG / モバイル最適化 |

## 7. 見積り注意 (実装者へ)
- 最難関は EEP の正しさ (テスト工数の 50%, docs/11 §3)。次点は **tick スロット設計** (サブリクエスト 50/呼出し制約下のスケジューリング) — schedule.ts を最初に表として固めてから書く
- アダプタ 1 本 0.5–1 日 × 11 本 (並行可)。UI 最重量は Dossier (3–4 日)、次いで Explorer (DuckDB-WASM 初期化とカタログで 2–3 日)
