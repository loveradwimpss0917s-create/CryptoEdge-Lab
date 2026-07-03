# 13. 無料運用設計 (Free Tier Plan) — 予算・上限・処理配置の正典

> 本書が「月額 ¥0 で数年間動く」ことの根拠。**全無料枠の消費予算をここで一元管理**し、上限値の変動 (プラン改定) があればまず本書を更新する。
> 上限値は 2026-07 時点の Cloudflare/GitHub 公表値に基づく。**実装開始時に必ず公式ドキュメントで再確認すること**。

---

## 1. ① Cloudflare 無料プランで可能な最大構成

| リソース | Free 上限 (要再確認) | 本設計の定常消費 | 消費率 | 設計上の対応 |
|---|---|---|---|---|
| Workers リクエスト | 100,000/日 | Cron ~314 + API ~2,000 (単一ユーザ) + lake パススルー ~1,000 | ~3% | 静的アセット配信は無料枠にカウントされないため SPA は実質無制限 |
| Workers CPU | 10ms/呼出し | fetch+parse+UPSERT で <5ms | — | 重い処理の全面禁止 (docs/01 §3 の規約)。gzip すら Actions へ |
| サブリクエスト | 50/呼出し | 1 tick 最大 40 fetch | 80% | ソースを 5 分スロットに静的割付け。超過しそうならスロット分割 |
| Cron Triggers | 5 本/アカウント (Free、他プロジェクトと共有) | 1 本 | — | 1m tier を廃止し 5m tick で 1m 足を 5 本まとめ取り。1h/1d/週次は同一 tick 内の壁時計判定で内製 (schedule.ts `tiersForTick`) |
| D1 ストレージ | 5 GB | 定常 ~1.2 GB (§2.1) | 24% | 保持期間の宣言的管理 + 週次アーカイブ |
| D1 行読取り | 5,000,000/日 | UI+internal で <100K/日 | 2% | Actions は D1 でなく R2 Parquet を読む |
| D1 行書込み | 100,000/日 | ~15K/日 (§2.2) | 15% | バッチ UPSERT。バックフィルは 80K/日でスロットリング |
| KV 書込み | 1,000/日 | <20/日 (フラグのみ) | 2% | 最新値スナップは D1 表へ、キャッシュは Cache API へ移管 |
| KV 読取り | 100,000/日 | <5K/日 | 5% | — |
| R2 ストレージ | 10 GB | ~1.2 GB/年 (§2.3) | 6–7 年分 | raw 90 日削除 + zstd Parquet 化 |
| R2 Class A (書込) | 1,000,000/月 | ~110K/月 | 11% | raw PUT は tick 単位 (バラ書きしない) |
| R2 Class B (読取) | 10,000,000/月 | ~300K/月 (DuckDB Range 読み含む) | 3% | Parquet は日付パーティションで読み範囲最小化 |
| Cache API | 無制限 | — | — | KV キャッシュの全面代替 |
| Cloudflare Access | 50 ユーザまで無料 | 1 ユーザ | — | 認証コスト 0 |
| Queues / AI Gateway 常用 / Durable Objects | 有料 or 不要 | **不使用** | — | Queues→D1 タスク表、AI→ハンドオフ (docs/07) |

## 2. 容量・書込み予算の内訳

### 2.1 D1 ストレージ (目標: 定常 ≤ 2GB, 上限 5GB の 40%)

| データ | 保持 (無料版で短縮) | 定常サイズ |
|---|---|---|
| candles 1m (2 銘柄) | **30 日** (旧 90 日) → R2 | ~15 MB |
| candles 5m/1h/1d | 5m は **180 日** (旧 400 日)、1h/1d 永続 | ~120 MB |
| OI / L/S / 清算 / 板スナップ (5m) | **180 日** (板 90 日) → R2 | ~250 MB |
| metrics (5m 系 180 日 / 日次永続) | | ~150 MB |
| funding / options_surface / events / regimes | 永続 | ~30 MB |
| 研究系 (edges/runs/metrics/signals/findings) | 永続 | ~100 MB/年 |
| **合計** | | **~0.7 GB + 0.1 GB/年** |

D1 使用率 50% (2.5GB) で Telegram 警告 → 保持期間短縮 or 有料化判断 (§5)。

### 2.2 D1 書込み (目標: ≤ 20K 行/日, 上限の 20%)

| ストリーム | 行/日 |
|---|---|
| candles 1m ×2 + 5m/1h/1d | ~3,600 |
| OI + L/S(4種) + 清算 + 板 (5m ×2 銘柄) | ~4,000 |
| metrics 5m (~6 系列) + 日次 (~100) | ~1,900 |
| latest_snapshots (UPSERT ~12 keys × 288) | ~3,500 |
| ingest_tasks / dq / audit / paper_signals / internal 還流 | ~2,000 |
| **合計** | **~15,000** |

### 2.3 R2 ストレージ (10GB を 6 年以上持たせる)

| 区分 | 年間増分 |
|---|---|
| curated Parquet (zstd): 1m 足 ~80MB + 5m 系 ~250MB + 日次 ~20MB | ~350 MB |
| features / artifacts / packs / reports | ~300 MB |
| backups (世代 8 週ローリング) | 定常 ~500 MB |
| raw NDJSON (90 日ローリング, 無圧縮) | 定常 ~400 MB |
| **合計** | **定常 ~1 GB + ~0.7 GB/年** |

## 3. ② GitHub 無料プランで可能な最大構成

| 項目 | Free 上限 | 本設計の消費 | 対応 |
|---|---|---|---|
| Actions (private repo) | 2,000 分/月 (Linux 標準) | ~1,200 分/月 | daily-light 10分×30=300 / weekly-heavy 90分×5=450 / on-demand 15分×~20=300 / CI ~150 |
| 同時実行 | 20 jobs | 1–2 | 問題なし |
| Artifacts/Packages 保存 | 500 MB | ~0 | 成果物は全部 R2 へ (Artifacts に依存しない) |
| リポジトリ | 無制限 | 1 | — |
| repository_dispatch / workflow_dispatch | 無料 | 毎日 1 + 週 1 + 随時 | Worker からの dispatch を正とし schedule は保険 |

**予算超過時の弁**: (1) on-demand 評価の月間上限を settings で 20 回に制限し UI に残量表示 (2) weekly-heavy の Permutation/Bootstrap 回数は設定値 (既定 1,000/2,000 回) で、超過月は自動半減 (3) 最終手段: リポジトリ public 化で分数無制限 (研究秘匿とのトレードオフ、ユーザー判断)。

## 4. ③ 無料 API 一覧 (V1 で使うもの)

詳細仕様は docs/03。**全て無料・大半はキー不要**:

| ソース | キー | 取得内容 |
|---|---|---|
| Binance REST + data.binance.vision | 不要 | OHLCV/funding/OI/LS/taker 比/板スナップ/全量ヒストリカル ZIP |
| Bybit / OKX REST | 不要 | 冗長系 + funding 乖離 + OKX 清算集計 |
| Deribit public | 不要 | DVOL / オプション板サマリ (IV, OI, max pain) |
| Coinbase Exchange / Upbit | 不要 | プレミアム系 (Coinbase/Kimchi) |
| Coin Metrics Community | 不要 | 日次オンチェーン ~40 系列 (MVRV 等) |
| blockchain.com Charts / mempool.space | 不要 | ハッシュレート・手数料環境 |
| DefiLlama | 不要 | ステーブルコイン供給 / DEX 出来高 |
| alternative.me | 不要 | Fear & Greed |
| CFTC COT (公式 CSV) | 不要 | COT ポジション |
| Farside (HTML) + SoSoValue | 不要 | ETF 日次フロー (二重化) |
| FRED | 無料キー | DXY/M2/VIX/金利/KRW |
| Etherscan / Tronscan | 無料キー | USDT Treasury ミント/バーン検知 |
| Yahoo Finance (+Stooq 予備) | 不要 (非公式) | CME BTC 先物日足・株指数 |
| Google Trends | 不要 (非公式) | 検索量 (週次) |
| Hyperliquid public | 不要 | オンチェーン板 (V2) |
| CoinGlass **無料枠のみ** | 無料キー | 清算集計の補完 (V2, 有料機能は使わない) |

**不採用 (有料のため)**: CryptoQuant, Glassnode (有料範囲), Amberdata, Kaiko, Tardis, Whale Alert 有料枠, Nansen。ただし metric_defs へ**予約登録済み** (docs/03 §2.4) で、契約時はアダプタ追加のみ。

## 5. ④⑤⑥ 処理配置の正典 (どこで何を計算するか)

| 処理 | ④ Workers | ⑤ Actions | ⑥ ブラウザ |
|---|---|---|---|
| データ収集・正規化・DQ 検査・UPSERT | ✅ | | |
| 軽量派生値 (プレミアム率, z-score 逐次更新) | ✅ | | |
| ペーパーシグナル判定 (DSL 閾値式) | ✅ (5m tick) | | |
| REST API / 認証 / Cache / 通知 | ✅ | | |
| バックフィル (一括ヒストリカル) | | ✅ | |
| 特徴量の全量/増分計算 → Parquet | | ✅ daily | |
| EEP (WF / CPCV / **Permutation** / **Bootstrap** / **Monte Carlo**) | | ✅ on-demand | |
| Discovery スクリーニング / **XGBoost+SHAP** / **Feature Importance** | | ✅ weekly | |
| HMM / Change Point / CUSUM | | ✅ daily(CUSUM)・weekly(他) | |
| 相関行列・ポートフォリオ統計 | | ✅ weekly | |
| Parquet 圧縮・raw 削除・アーカイブ・バックアップ | | ✅ weekly | |
| Research Pack 生成 (テンプレ) | ✅ (随時分) | ✅ (定期分) | |
| アドホック探索 (任意条件の分布・層別・相関) | | | ✅ DuckDB-WASM |
| チャート描画・集計・CSV/MD エクスポート | | | ✅ |
| AI 解析 | | | ✅ 手動ハンドオフ (docs/07) |

**判定基準** (実装時に迷ったら): リアルタイム必要 → Workers (ただし CPU 10ms 以内で書けるものだけ) / 分単位で良い・重い → Actions / 対話的・探索的 → ブラウザ。

## 6. ⑦ 有料化するときだけ追加する機能 (トリガー付き)

| 機能 | 追加コスト目安 | 有料化トリガー (これが起きるまで契約しない) |
|---|---|---|
| Workers Paid (Queues, CPU 5分, D1 10GB+) | $5/月 | D1 が 2.5GB 超 or 収集ソース 30 超で tick 予算が破綻 |
| CoinGlass 有料 (清算ヒートマップ) | ~$30/月 | EC-006/008 系が PAPER で有望かつ無料データの粒度が検証のボトルネックと判明 |
| CryptoQuant / Glassnode | $30–100/月 | オンチェーン系 finding が FDR 通過し、無料代理変数 (docs/03 §2.4) では反証しきれない場合 |
| AI API 常時 (`ai-autopilot`) | $5–15/月 | 手動ハンドオフが週 5 往復超 (docs/07 §6) |
| Vectorize + embedding | 少額 | Dossier/Briefing が 500 本超で全文検索に不足を感じたら |
| 自前ランナー / Containers | $5–20/月 | Actions 分数が 3 ヶ月連続 1,800 分超 |
| Tardis/Kaiko (ティック) | $100+/月 | V3 マイクロ構造研究の着手判断時 |

**移行がスムーズな理由**: すべて docs/01 §7 の差込み口 (アダプタ契約・tasks インターフェイス・宣言的保持期間・Pack 契約) を最初から設けてあるため、契約 = 設定変更 + 1 モジュール追加で済む。

## 7. 無料枠ヘッドルーム監視 (自己監視を本番機能にする)

- ingest tick-1d が毎日計測して D1 `quota_usage` (docs/02 §2.1) に記録: D1 行数/サイズ (`PRAGMA` 系 + 集計)、当日書込み行数 (自前カウンタ)、R2 使用量 (weekly の manifest 集計)、Actions 消費分 (GitHub API `/actions/.../timing` 相当を weekly 取得)
- 各予算の 60% で Data Health 画面に注意表示、80% で Telegram 通知 + 自動緩和 (保持期間短縮・Permutation 回数半減など、settings に定義された降格アクション)
- **quota は「落ちてから気付く」ものではなく、ダッシュボードの一級市民** (SCR-05 に常設)
