# 05. Edge 評価システム (Edge Evaluation Protocol, EEP)

> 全 Edge が同一パイプラインを通る。これが PDF W3 (評価基準の混在) の解決であり、プラットフォームの背骨。
> 実行: research-worker。結果: `eval_runs` / `eval_metrics` / `verdicts`。表示: Dossier (SCR-03)。

---

## 1. プロトコルのバージョン管理

- `protocol_version` (semver) は research パッケージのリリースと連動。**判定 (verdict) は必ず protocol_version + thresholds_version の組で記録**され、プロトコル改訂時に過去 Edge を新プロトコルで再評価するジョブ (`eep_full` 一括) を発行できる。
- 本書が定義するのは `EEP 1.0`。

## 2. Edge ライフサイクル状態機械

```
IDEA ──(hypothesis+rationale 記入)──▶ CANDIDATE ──(screen run 合格)──▶ TESTING
TESTING ──(full run: ADOPT)──▶ VALIDATED ──(30d ペーパー開始)──▶ PAPER
PAPER ──(ペーパー成績が OOS 予測と整合)──▶ ACTIVE
ACTIVE ──(CUSUM 劣化検知)──▶ DECAYING ──(90d 回復せず)──▶ RETIRED
DECAYING ──(回復)──▶ ACTIVE
任意状態 ──(full run: REJECT / 手動)──▶ REJECTED / RETIRED
REJECTED/RETIRED ──(新バージョン作成)──▶ CANDIDATE (再挑戦。試行回数は引き継ぐ)
```

遷移規則 (実装は packages/schema/src/domain の状態機械として単一実装):

| 遷移 | ガード条件 | actor |
|---|---|---|
| IDEA→CANDIDATE | hypothesis, rationale, counter_evidence 非空 + edge_version v1 存在 | user |
| CANDIDATE→TESTING | screen run (簡易 EEP) で `ev_bps > 0` かつ `p_perm < 0.20` | system (提案) + user (承認) |
| TESTING→VALIDATED | full run の verdict = ADOPT | system 提案 + user 承認 |
| VALIDATED→PAPER | ユーザー操作 (自動でペーパーシグナル収集開始) | user |
| PAPER→ACTIVE | ペーパー期間 ≥ 30 日 ∧ シグナル ≥ 10 ∧ ペーパー Sharpe ≥ OOS Sharpe 95% CI 下限 (片側。上限超過は成績が良いだけなので却下しない — 2026-07 レビュー H-4) ∧ 平均スリッページが想定コスト内 | system 提案 + user 承認 |
| ACTIVE→DECAYING | §7 の CUSUM 警報 | system (自動) |
| →REJECTED | verdict=REJECT または user 判断 | system/user |

**すべての遷移は `edge_transitions` に理由付きで記録** (audit)。

**screen run の「簡易」の実体** (2026-07 レビュー TASK-5): `run_kind='screen'` は `eval/pipeline.py` の `SCREEN_EEP_CONFIG` (permutation 200 回・bootstrap 300 回・walk-forward 3 fold、full run の 1000/2000/5 の 1/5〜1/7) で実行され、CANDIDATE→TESTING ゲートが読む `overall.ev_bps`/`wf:oos.p_perm` の計算コストを実際に下げる。以前は `run_kind` に関わらず常に full 相当の設定で実行しており、「screen」は名目上のラベルに過ぎなかった。

**2026-07-11 追記 (バグ修正)**: `apps/api/src/services/edge-lifecycle.ts` の
CANDIDATE→TESTING ゲートが誤って `overall.p_perm` を読んでいたが、
`p_perm` は `eval/pipeline.py` の permutation test が常に `wf:oos` セグメントにしか
書き込まないため、このゲートは実装上一度も通過し得なかった (本番D1で確認: 7件の
CANDIDATE Edgeのうち、一度でも CANDIDATE→TESTING への遷移が試みられた記録はゼロ)。
`wf:oos.p_perm` を読むよう修正し、本番の実データで「月曜アジア開場効果」が
実際にゲートを通過することを確認した。

## 3. Full Run パイプライン (8 ステージ)

### 3.1 データセット固定
snapshot manifest (docs/01 §4.3) を作成/参照し `dataset_hash` を確定。PIT 検査: 使用系列の `pit_lag`/`revisable` を尊重した as-of ビューを構築。

### 3.2 シグナル生成とターゲット
- signal_spec (DSL, §9) から発火系列を決定論生成
- 執行モデル: **発火の次バー始値でエントリ** (同バー終値執行は禁止 = look-ahead)、exit は horizon 満了 or 明示 exit 条件。イベント型は event ts + 遅延 (既定 1 バー)
- イベント型 Edge はイベントスタディ形式 (CAR + 対照ブートストラップ) を併走

### 3.3 コストモデル適用
edge_version.cost_model (既定 taker 4bps + slip 2bps/side、funding 保有コスト含む)。コストゼロ系は `segment='cost:zero'` として参考保存のみ。

### 3.4 Walk-Forward + Purged K-Fold
- **アンカー付き WF**: 学習窓拡張型、テスト窓 6 ヶ月、最低 5 folds。パラメータを持つ Edge は各 fold の学習窓のみで再適合
- **Purging + Embargo (5 日)**: horizon が跨ぐサンプルの学習混入を排除 (López de Prado)。**なぜ**: 自己相関のある forward return では通常 CV が壊滅的に楽観化する
- OOS 成績 (`wf:oos`) が主評価。fold 別も保存し、**fold 間の符号一貫性** (全 fold 中 EV>0 の割合) を頑健性指標にする

### 3.5 Permutation Test
- シグナル時刻の**ブロックシャッフル** (ブロック長 = horizon×3) で帰無分布を 1,000 回生成 → `p_perm` = 実測 EV を超える割合
- **なぜ**: 分布仮定なしで「このシグナルはタイミング情報を持つか」だけを検定できる。t 検定より crypto のファットテールに頑健

### 3.6 Bootstrap CI
- **Stationary bootstrap** (平均ブロック長 = horizon×3, 2,000 回) でトレードリターン系列を再抽出 → Sharpe / EV / MaxDD の 95% CI
- 勝率は **Wilson CI** (正確・小標本対応)
- **実効 N**: `n_eff = n × (1−ρ)/(1+ρ)` (シグナル重複・自己相関補正)。`n_eff < 30` の Edge は verdict を保留し `WATCH` 止まり

### 3.7 多重検定補正 (PDF W1 の解決)
- **Deflated Sharpe Ratio (DSR)**: 当該 edge への累積試行数 (eval_runs の screen+full 数) と試行間分散から、最大 Sharpe の期待インフレを控除した確率 `P(SR真 > 0)` を算出
- **PSR** (Probabilistic Sharpe Ratio): 歪度・尖度補正付き
- Discovery 由来の Edge は、出自バッチの試行空間サイズを試行数に合算する (`discovery_findings.batch_id` から取得)
- **なぜ**: 「何回試したか」を無視した Sharpe は無意味。試行の完全記録 (Trial Registry = eval_runs) がここで効く

### 3.8 レジーム別・時期別セグメント
`regime:{label}` 別、`year:{yyyy}` 別、直近 1y の成績を必ず算出。**単一年/単一イベント (例: Mar 2020) に利益が集中していないか**を自動フラグ (利益上位 5 トレードの寄与率 > 60% で警告 — PDF の Edge 015 問題の一般化)。

## 4. メトリクス定義 (eval_metrics.metric の正準リスト)

| metric | 定義 | 备考 |
|---|---|---|
| `ev_bps` | 1 トレード当たり期待値 (コスト後, bps) | 主指標 |
| `win_rate` | 勝率 + Wilson CI | |
| `pf` | Profit Factor | |
| `sharpe` / `sortino` / `calmar` | 年率化。シグナルベース戦略は保有期間リターンから年率換算 | |
| `max_dd` / `dd_duration_days` | | |
| `trades` / `n_eff` | 総数 / 実効サンプル | |
| `p_perm` | Permutation p 値 | |
| `dsr` / `psr` | Deflated / Probabilistic SR | |
| `fold_consistency` | WF fold 中 EV>0 の割合 | |
| `regime_worst_ev` | 最悪レジームの EV | |
| `top5_concentration` | 利益上位 5 トレード寄与率 | |
| `turnover` | 年間シグナル数 | 執行負荷 |
| `capacity_usd` | 容量推定: シグナル時刻の板深度/出来高から線形インパクトで逆算 | 個人運用では参考値 |
| `auc` / `precision` / `recall` / `f1` | 分類型 (方向予測) Edge のみ | |
| `ir` | ベンチマーク (BTC B&H) 対比の情報比 | |
| `corr_max_active` | 既存 ACTIVE Edge との最大リターン相関 | §8 |

## 5. Verdict 判定 (決定論ルール)

`settings['thresholds.eep']` (バージョン付き) の既定値。すべて `wf:oos` セグメント・コスト後:

**ADOPT (全条件 AND)**
1. `ev_bps > 0` の 95% Bootstrap CI 下限 > 0
2. `sharpe >= 1.0` (PDF の採用基準を踏襲) かつ `dsr >= 0.90`
3. `p_perm < 0.05`
4. `n_eff >= 30`
5. `fold_consistency >= 0.7`
6. `regime_worst_ev > -2 × ev_bps` (最悪レジームで軽微な負まで許容)
7. `top5_concentration < 0.6`
8. `corr_max_active < 0.7` (超える場合は §8 の限界貢献判定へ)

**REJECT (いずれか OR)**: CI 上限 < 0 / `p_perm > 0.30` / `dsr < 0.5` / 直近 2y の EV < 0 (死んだ過去の Edge)

**WATCH**: 上記以外すべて。再評価スケジュール (90 日後 or データ追加時) を自動設定。

`verdicts.reasons` に全チェックの pass/fail と実測値を保存し、UI は必ず「なぜこの判定か」を表示する。

## 6. 総合スコア (UI 表示用, 0–100)

`score = 40×min(dsr,1) + 20×min(sharpe/2,1) + 15×fold_consistency + 15×(1−top5_concentration) + 10×regime_breadth`。閾値判定はスコアでなく §5 のルールで行う (スコアは並び替え用)。

## 7. 劣化監視 (ACTIVE/PAPER Edge, 毎晩)

- 各シグナルの実現リターン − OOS 期待値 の累積偏差に **CUSUM 検定** (h = 4σ)。警報で DECAYING へ自動遷移 + Briefing 通知
- 補助: 直近 20 シグナルのローリング Sharpe が OOS Sharpe の Bootstrap 95% 区間の下限を割ったら注意フラグ
- **なぜ CUSUM**: 少数サンプルで平均シフトを最速検知する古典。公表アノマリーの減衰 (McLean & Pontiff) は「緩やかな平均シフト」であり、これに最適
- DECAYING 中は Briefing に「疑われる原因」テンプレ (レジーム変化 / 混雑 / データ品質 / 構造消滅) を AI が起草 (docs/07)

## 8. ポートフォリオ視点 (PDF W5 の解決)

- 毎晩 `edge_correlations` を更新 (ACTIVE+PAPER+VALIDATED 対象)
- 新規 ADOPT 候補は「既存 ACTIVE ポートフォリオ (等リスク加重) に追加したときの **限界 Sharpe 改善**」を算出。改善 < 0.05 なら verdict を WATCH に降格し「重複」と明記
- ポートフォリオ画面 (SCR-02 内タブ) は相関ヒートマップ + クラスタ (階層クラスタリング) を表示し、「実質何個の独立な Edge を持っているか」(有効独立数 = 相関行列の固有値エントロピー) を KPI にする

## 9. シグナル定義 DSL (signal_spec)

Edge の再現性とペーパートレードの軽量実行のため、シグナルは制約付き JSON DSL で表現する (チューリング完全な自由コードは禁止):

```
{
  "when":  BoolExpr,        // 発火条件
  "entry": {"delay_bars": 1, "price": "open"},
  "exit":  {"horizon": "72h"} | {"cond": BoolExpr, "max_horizon": "72h"},
  "direction": "long" | "short" | "signal_sign"
}
BoolExpr = {"and"|"or": [BoolExpr...]} | {"not": BoolExpr}
         | {"cmp": [FeatureRef, ">"|"<"|">="|"<=", number | FeatureRef]}
         | {"event": {"type": "usdt_mint", "min_magnitude": 2.0}}
         | {"regime": {"trend": ["up"], "liquidity": ["normal"]}}
         | {"time": {"utc_hour_in": [21,22], "dow_in": [...]}}
FeatureRef = {"feature": "funding_z_90d"} | {"feature": "...", "lag": 1}
```

- research (Python) と ingest Worker (TS) の**両方に同一セマンティクスの評価器**を実装し、共通のゴールデンテストベクトルで一致を保証する (docs/11 §4)。これにより「バックテストしたものと同じ定義」がリアルタイムでペーパー発火する
- DSL で表現できない Edge (例: 執行内アルゴが本体のマイクロ構造系) は V1 では PAPER 以降に進めない (研究のみ)

## 10. ペーパートレード (PAPER/ACTIVE)

- ingest の 5 分 tick がシグナル評価 → `paper_signals` に open/close 記録 (docs/02 §2.5)
- 約定価格: シグナル確定後の次バー始値 + 想定スリッページ。`trigger_snapshot` に入力値一式を保存 (「あのときなぜ発火したか」の完全再現)
- 週次でペーパー vs バックテスト OOS の乖離レポート (Briefing 掲載)
