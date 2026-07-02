# 04. Edge Discovery Engine

> 本書は「未知の Edge をどう発見するか」の方法論と実装仕様。実行主体は research-worker (Python)、結果の受け皿は `discovery_findings` → Edge レジストリ (docs/02 §2.5)。

---

## 1. 発見の哲学 — なぜ「手法カタログ」ではダメか

未知の Edge は「指標の新しい組合せ」からではなく、**誰かが経済的合理性なしに売買を強制される場所**から生まれる。PDF の構造分析が正しく指摘する通り、持続する Edge の源泉は:

1. **強制フロー**: 清算、ETF 償還/設定、オプションヘッジ、インデックスリバランス、funding 決済 — 価格に無関心な注文
2. **構造的ミスマッチ**: 24/7 市場 × 平日市場 (CME/NYSE/ETF)、地域分断 (Kimchi)、規制分断
3. **情報の非対称/遅延**: オンチェーン→価格、デリバティブ→現物、大口→公表
4. **行動バイアス**: FOMO、ラウンドナンバー、群集の L/S ポジション

したがって Discovery Engine の仕事は「4 つの源泉のどれかに接地した仮説を、系統的に生成し、統計的に選別する」ことである。**接地のない純粋データマイニングの発見は、FDR 補正後 q 値がどれほど良くても IDEA 止まりとし、経済的根拠が書けたものだけが CANDIDATE に昇格できる** (状態機械で強制、docs/05 §2)。

## 2. 二つの発見ループ

```
ループ A: 仮説駆動 (人間 + AI)                ループ B: データ駆動 (機械)
 文献/観察 → 仮説記述 → Edge(IDEA) 登録        特徴量ストア → 系統的スクリーニング
      │                                        → findings (FDR 補正済み)
      └────────→ EEP 評価 ←──────── 経済的根拠を付けて昇格 ┘
```

ループ B は「仮説の証明」ではなく「仮説の弾薬庫」である。findings は毎晩自動生成され、研究者 (と AI, docs/07 §4) が翌朝レビューする。

---

## 3. 特徴量ストア (Feature Store)

### 3.1 実体

- R2 `features/{feature_set_version}/dt=*/features.parquet` — 行 = (ts, instrument)、列 = feature
- 台帳 = D1 `feature_defs`。**すべての特徴量は spec (入力・変換・窓・ラグ) から決定論的に再計算可能**
- cadence は `1d` を主軸 (V1)、`1h` を副軸。5m 以下は V3

### 3.2 変換文法 (Transformation Grammar)

生データ → 特徴量は、有限の変換演算子の合成として定義する。これにより候補生成が組合せ的に列挙可能になり、かつ**試行空間のサイズが既知になる (多重検定補正の前提)**。

| 演算子 | 定義 | 例 |
|---|---|---|
| `level` | 素の値 | funding_rate |
| `chg(w)` / `pctchg(w)` | w 期間差分/変化率 | OI 24h 変化率 |
| `z(w)` | ローリング z-score (w=30d/90d/365d) | funding z 90d |
| `pctile(w)` | ローリングパーセンタイル順位 | DVOL 1y percentile |
| `ma_ratio(s,l)` | 短長移動平均比 | stable_mcap MA7/MA30 |
| `accel(w)` | 変化率の変化率 | 発行加速 (033) |
| `vol_adj` | ATR/実現ボラで正規化 | ギャップ幅/ATR14 (021) |
| `sign_run(n)` | 同符号連続数 | ETF フロー連続流入日数 |
| `divergence(a,b,w)` | 2 系列のローリング相関からの残差 | 価格↑×OI↓ (009), 価格 vs CVD (005) |
| `event_window(type, pre, post)` | events テーブルとの結合 | FOMC 前日 (041) |
| `interact(f1,f2)` | 積/条件積 | 清算 z × funding z |

`feature_defs.spec` = `{base: metric_id|table.column, ops: [{op, params}...], cadence}` の JSON。

### 3.3 V1 初期特徴量セット (~120 本)

ベース系列 (~40: docs/03 §3 の metrics + funding/OI/LS/liq/candles 派生) × 主要変換 (level, z90, pctile365, chg24h) を基本とし、PDF 候補の再現に必要な特殊特徴量 (cme_gap_pct, hour_of_day, dow, usdt_mint_flag 等) を加える。実装時は `research/src/cryptoedge_research/features/registry.py` に本表を転記して定義する (docs/09 §3 に P0 分のみ明記)。

---

## 4. 候補生成 — 何を試すかの文法

候補 = `(feature 条件) × (対象 instrument) × (方向) × (保有 horizon)`:

- 条件テンプレート: `f > θ` / `f < θ` (θ ∈ {±1σ, ±2σ, p5, p95}), `event 発生`, `f1 極値 ∧ f2 極値` (2 次交互作用まで)
- horizon: {1h, 4h, 24h, 72h, 7d} (1d cadence の場合)
- 方向: forward return の符号で自動判定 (long/short)

**試行空間の管理**: 120 features × 4 条件 × 5 horizons ≈ 2,400 の一変量候補 + 選抜上位の交互作用 ~500。全試行数はバッチごとに記録され、FDR の分母になる。**θ のグリッドを増やす・horizon を増やす行為は試行空間を拡大し発見の信頼性を下げる**ことを UI でも明示する (SCR-04)。

---

## 5. スクリーニングパイプライン (毎晩 + 週次)

### Stage 1: 条件付き期待リターン走査 (毎晩, 増分)

- 各候補について: 条件成立時の forward return 分布 vs 無条件分布
- 統計量: 平均差の t (Newey-West 補正, 自己相関対応)、Mann-Whitney U (非正規対応)、hit rate の Wilson CI
- **なぜこれか**: 最も単純で解釈可能。仮説の形 (「X のとき上がる」) が Edge 定義 DSL に直訳でき、EEP へ滑らかに接続する
- 出力: 全候補の統計表 → バッチ内 **Benjamini–Hochberg FDR** (q<0.10) を通過したものだけ `discovery_findings` へ

### Stage 2: イベントスタディ (毎晩, events 更新分)

- `events` の各 type について、t=0 前後の累積異常リターン (CAR) と CI (対照: 同時刻・同曜日のブートストラップ分布)
- **なぜ**: USDT 発行 (031)、FOMC (041)、清算カスケード (006) など PDF の主力 Edge はすべてイベント型。事象時刻が明確なぶん、時系列 CV より検定力が高い

### Stage 3: 条件付け探索 — 交互作用とレジーム (週次)

- Stage 1 通過候補 × レジームラベル (§6) / 他特徴量極値 で層別し、効果の異質性を検定
- **なぜ**: 「funding 逆張りはストレス流動性レジームでのみ効く」型の発見が、単変量走査では平均に埋もれる。PDF W6 の解決
- 過剰分割の防御: 層別後の実効 N < 50 の細胞は評価対象外

### Stage 4: ML による非線形仮説生成 (週次)

- **XGBoost** (forward return 符号の分類 + 分位回帰) → **SHAP** で特徴量寄与と交互作用を抽出
- 学習は purged 時系列分割 (docs/05 §3.4 と同じ枠組み)。目的は予測器の採用ではなく、**SHAP 上位の交互作用を Stage 1 形式の候補に逆翻訳して弾薬庫に足す**こと
- **なぜ XGBoost + SHAP か**: 欠損耐性・単調性制約・少データでの頑健性が線形系より高く、SHAP で「どの条件がいつ効いたか」を人間可読の仮説に戻せる。Deep 系は BTCUSDT 日次規模 (N~3000) では過学習が支配的で採用しない
- 補助: **ロジスティック回帰 (L1)** を同じタスクに並走させる。**なぜ**: 線形で拾える構造は線形で拾うのが最も頑健で、XGB との一致/不一致自体が発見の確信度情報になる

### Stage 5: 異常検知・構造変化 (週次)

- **Change Point Detection (PELT / Bayesian Online CPD)**: 各系列と既存 Edge の性能系列に適用。**なぜ**: (a) Edge 劣化の早期警報 (docs/05 §7 の CUSUM と相補)、(b) 「構造が変わった点」の前後は新 Edge が生まれる場所 (例: ETF 承認前後の相関構造変化 — PDF 035)
- **異常検知 (季節分解 + robust z, Isolation Forest)**: データ品質異常 (DQ-03 の二次判定) と「説明のつかない市場挙動」の検出。後者は AI が文献照合して仮説化を試みる (docs/07 §4)

### 採用しない/劣後させる手法とその理由

| 手法 | 判断 | 理由 |
|---|---|---|
| 遺伝的プログラミングによる式探索 | 不採用 | 試行空間が非可算的に膨張し FDR 管理が崩壊。経済的接地も失われる |
| LSTM/Transformer 価格予測 | V3 で研究補助のみ | N が小さく、解釈不能な発見は本プラットフォームでは昇格できない |
| 単純相関マトリクス全走査 | Stage 1 に包含 | 相関単体は非定常で誤発見の温床。条件付き期待リターン形式に統一 |
| ベイズ推定 | 部分採用 | 完全ベイズ WF は重い。Wilson CI・ベイズ的事前 (priors) とベイズ最適化 (V2 のパラメータ探索, 試行数を抑える目的) に限定 |
| Monte Carlo | EEP 内で採用 | 発見でなく評価側 (Permutation/Bootstrap, docs/05) |

---

## 6. レジームモデル (全社共通の条件変数)

### 6.1 二本立て

| モデル | 内容 | 用途 |
|---|---|---|
| **ルールベース** (主) | trend: close vs SMA200 ± ADX / vol: RV30 の 1y パーセンタイル (p33/p90 で 3 分割) / liquidity: spread p90 超 ∨ 清算 z>3 ∨ stable 乖離>50bps で `stressed` | 決定論・因果的 (その日のデータだけで計算可能) → **バックテストで使ってよい唯一のラベル** |
| **HMM (3–4 状態, ガウス放出: 日次リターン+RV)** (副) | 教師なし状態推定 | 研究・可視化用。**フィルタ確率 (因果) のみバックテスト使用可、スムージング確率は表示専用** |

### 6.2 なぜこの設計か

- Hidden Markov / レジームスイッチングは「もっともらしい後知恵」を作りやすい。スムージング確率でのバックテストは classic な look-ahead。→ 因果性をラベルの第一級属性にする
- ルールベース主軸なのは、レジーム定義自体がバージョン管理・説明可能であるべきだから (レジームが変わると全 Edge の評価が変わる = プラットフォーム最大の共有依存)

### 6.3 実装仕様

- 毎晩 research-worker が `regimes_daily` を更新。HMM は月次で再学習し `model_version` を上げる (過去ラベルの遡及変更は新 model_version の列として保存、旧版も参照可能)
- EEP は評価時にレジーム別セグメント (`regime:{trend}_{vol}_{liq}`) の成績を必ず算出 (docs/05 §5)

---

## 7. Novelty (新規性) 管理

findings と既存 Edge の重複を防ぐ:

- finding のシグナル系列と全既存 Edge Version のシグナル系列の Jaccard 重複率を計算 (`discovery_findings.novelty` = 1 − max overlap)
- novelty < 0.3 は `duplicate` として自動クローズ (該当 Edge の Dossier に「別定式化」として記録)
- **なぜ**: 同一現象の再発見に検証予算を浪費しない。かつ「独立に見えて同じ現象」を束ねることが W5 (ポートフォリオ重複) の一次防衛

## 8. 昇格フロー (findings → Edge)

1. 毎朝の Briefing に「新規 findings 上位 (q 値 × novelty × 効果量でスコアリング)」を最大 5 件表示 (SCR-01)
2. 研究者が Discovery Lab (SCR-04) で分布・レジーム別・時期別の安定性を確認
3. **昇格には hypothesis + rationale (§1 の 4 源泉のどれに接地するか) の記入が必須** → `edges` (CANDIDATE) が作成され、finding は `promoted`
4. AI は rationale のドラフトを提案できるが、確定は人間 (docs/07 §4)
