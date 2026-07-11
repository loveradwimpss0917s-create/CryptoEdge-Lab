# 18. Master Roadmap — CryptoEdge Lab 完成までの正典 (2026-07-05)

> **位置づけ**: 本書が今後のロードマップの**唯一の正典**。docs/09 はバージョン戦略と優先原理
> (P0-P3の意味、無料ファースト原則) の上位文書として維持し、タスク粒度の進捗管理は本書と
> docs/19 (Sonnet実装計画) で行う。docs/15 は凍結済みの実行ログ。
> **設計思想**: 「アプリを作るフェーズ」は終わった。以後のすべてのタスクは
> **(a) 検証できるEdgeの数を増やす、(b) 検証の正しさを守る、(c) 検証済みEdgeを執行に繋ぐ**
> のどれかに直結しなければ採用しない。

---

## 1. 現在地 (2026-07-05 実測)

- docs/09 Phase 0-3: **実装完了**。SONNET-1〜8 + Priority 1-3 (docs/15 §6-8) まで消化
- 本番: edges 55 / edge_versions 9 / eval_runs 15 (verdict 全REJECT) / paper_signals 0 /
  events 8 (fomcのみ) / 収集は okx(candles/funding/OI/LS/liq) + alternative_me + econ_calendar が正常、
  deribit_rest が429継続中
- V1 DoD: #4 (Pack) 達成済み。#1/#2 は測定手段が揃い7日実測待ち。#3 は 1/3件
  (utc-2123-drift REJECT 確定。残2件はイベント履歴バックフィル待ち — docs/17 §3.1-1)

## 2. バージョン定義と Definition of Done

### V1 「研究基盤が無人で回り、最初の検証群が完了している」

| # | DoD | 現状 | 残タスク |
|---|---|---|---|
| V1-1 | 全tier収集が7日間無人で品質スコア ≥99% (disabled除く) | 測定手段あり・未計測 | S-05 (+S-06 deribit判断) |
| V1-2 | 7日間のquota実測が docs/13 §1 予算内 | 記録あり・レポート未作成 | S-05 |
| V1-3 | P0シード5件に verdict (vrp-monitorは観測のみでよい) | 1/3 (2件はイベント履歴待ち) | S-03 → S-04 |
| V1-4 | daily_briefing Pack を AI に貼って解析できる | ✅ 達成 | — |
| V1-5 | CI が「緑=正常」を意味する (Smoke test 302 の恒常失敗を解消) | ❌ | S-01 |
| V1-6 | dq_issues が解決フローを持ち、Action Queue にノイズが無い | ❌ (未解決40件) | S-02 |

V1-5/V1-6 は docs/09 に無かったが、docs/17 監査で「無人運転の信頼性」の一部として追加した。

### V1.5 「検証スループットが立ち上がっている」

| # | DoD |
|---|---|
| V1.5-1 | Edge Pack v1 Phase 2-3 (weekly-breakout / round-number / FOMC 2件) が screen 済み |
| V1.5-2 | paper trading が `cmp` (feature) 条件のEdgeを扱える (Feature liveミラー) |
| V1.5-3 | funding コストがバックテストに反映されている |
| V1.5-4 | 残アダプタのうち defillama + fred が本番収集中 (分類C解除の開始) |
| V1.5-5 | LS/OI の履歴バックフィルが再試行され、結果 (成功/恒久断念) が記録されている |
| V1.5-6 | イベント履歴バックフィルが cme_gap / usdt_mint / fomc(過去年) をカバー |
| V1.5-7 | D1 retention ジョブが稼働 (古い1m candlesの削除、R2が正) |
| V1.5-8 | Explorer が実ブラウザで動作確認済み + wasm R2自己ホスト化 |
| V1.5-9 | Access Service Token による機械認証が稼働 |

### V2 「発見の量産と執行への接続」

| # | DoD |
|---|---|
| V2-1 | Discovery Engine Stage 1-3 + Findings Inbox (docs/04 §5, docs/06 SCR-04 完全版) |
| V2-2 | kasotubot 連携: シャドー運用 (docs/20 K-2) で30日、シグナル配信の欠落ゼロ |
| V2-3 | kasotubot 連携: 実行結果フィードバックが research に還流し、live-vs-paper 乖離が Dossier で見える |
| V2-4 | ADOPT Edge が1件以上 PAPER を経て ACTIVE に到達 (パイプライン全線開通の実証) |
| V2-5 | 相関・ポートフォリオビュー (edge_correlations 実データ) |
| V2-6 | HMM/CUSUM レジーム自動遷移 (docs/04) |

**注意**: V2-4 は統計の結果に依存するため「期日」を設定しない。ゲートを緩めて達成するのは本末転倒
(docs/00 の思想)。代わりに V2-2/V2-3 (シャドー配線) は ADOPT ゼロでも進められる設計にした (docs/20)。

---

## 3. Phase / Task / Priority 一覧

タスク詳細 (WHY/WHAT/DONE/受入条件) は docs/19。ここでは依存関係と順序のみ。

### Phase R1: V1 クローズアウト (P0, 順序厳守)

| Task | 内容 | 依存 | 完了条件 |
|---|---|---|---|
| S-01 | deploy.yml Smoke test 302 修正 | なし | CI緑=正常が成立 |
| S-02 | dq_issues 解決フロー (自動+手動) | なし | 未解決ノイズ0件 |
| S-03 | イベント履歴バックフィル (cme_gap/usdt_mint/fomc過去) | なし | cme_gap/usdt_mint実装済み・実行待ち。fomcは日程未確定でブロック中 (下記) |
| S-04 | P0シード残2件の再評価 (ユーザーがUIから実行、Sonnetは検証) | S-03 | verdict 2件確定 → V1-3 |
| S-05 | V1 DoD 7日実測レポート | S-01,S-02 開始後7日 | docs/18 §2 表の全行に実測値 |
| S-06 | deribit 72hルール判断 (降格 or retire) — **完了: 断続的429ノイズと判定、既存インフラで吸収済み、降格/retire不要** | 72h経過 | Data Health 整合 |
| S-07 | Explorer クローズアウト (実機確認 or 追加診断) | ユーザー確認 | 実ブラウザで分布表示 |
| S-91 | eval_runs スタックジョブ監視 (jobsの`STUCK_DISPATCHED_MS`相当をeval_runsにも) | なし | 放置run_idがExplorerアクセスで自動timeout化 |
| S-92 | yahoo_finance (cme_gap) がYahoo非公式APIのブラウザUA判定で6日連続429 → ブラウザ相当ヘッダー付与 | なし | 次回1dティックで consecutive_errors が0に戻る (要ユーザー確認) |
| S-93 | React側にルートエラー境界が皆無 (画面クラッシュ=白画面) → TanStack Router errorComponent 追加 | なし | 1画面のクラッシュがnav/layoutを道連れにしない |
| S-94 | **CANDIDATE→TESTING ゲートが `p_perm` を存在しないsegmentから読み実装上通過不能だった** (最重要バグ) | なし | 修正済み・本番D1の実データで「月曜アジア開場効果」が合格することを確認 |

**V1 完了宣言 = S-01〜S-07, S-91〜S-94 完了 + §2 V1表 全行 ✅**

### Phase R2: V1.5 研究スループット (P1)

| Task | 内容 | 依存 |
|---|---|---|
| S-08 | Edge Pack Phase 2: weekly-breakout screen + round_number op | S-04 (UIフロー実証済み) |
| S-09 | Edge Pack Phase 3: FOMC 2件 (負delay検証込み) + cpi feature単位修正 | S-03 |
| S-10 | defillama アダプタ (キー不要、metric_defs登録済み) | なし |
| S-11 | fred アダプタ (要 FRED_API_KEY secret) | ユーザーがkey取得 |
| S-12 | coinmetrics_community アダプタ | S-10の手順確立後 |
| S-13 | farside_etf (HTMLスクレイプ) / tronscan (冗長・skip判断) | S-12 |
| S-14 | LS/OI binance.vision バックフィル再試行 | なし |
| S-15 | Feature live ミラー (features_sync → latest_snapshots) | なし |
| S-16 | funding コストを CostModel/backtest に追加 | なし |
| S-17 | DSL `dom_in` 拡張 (schema+2評価器+golden) | なし (プロトコル変更なので単独タスク) |
| S-18 | D1 retention ジョブ | なし |
| S-19 | VRP (Edge Pack Phase 4) — **要ユーザー承認** (docs/09 §3 の前倒し, docs/17 Z-1)。deribit retire (S-06) になった場合は自動的に見送り | S-06 |
| S-20 | Access Service Token 認証 | なし (S-23以降の前提) |
| S-21 | wrangler v4 アップグレード | なし |
| S-22 | duckdb-wasm R2 自己ホスト | S-07 |

### Phase R3: V2 — kasotubot 連携 (docs/20 の K-フェーズ)

| Task | 内容 | 依存 |
|---|---|---|
| S-23 | K-1: signals 読み取りAPI + Service Token 認証 | S-20 |
| S-24 | K-2: portfolio-state 受信 + marginal impact 計算 + シャドー運用 | S-23, kasotubot側poller |
| S-25 | K-3: trade_executions フィードバック受信 | S-24 |
| S-26 | K-5: live-vs-paper 乖離監視 + decay 連動 | S-25, paper実績蓄積 |

### Phase R4: V2 — Discovery (docs/04)

| Task | 内容 | 依存 |
|---|---|---|
| S-27 | Discovery Stage 1 (条件付け走査) + discovery_findings 書き込み | V1完了 |
| S-28 | Findings Inbox UI + finding→Edge昇格フロー | S-27 |
| S-29 | CUSUM 劣化検知 + decay_investigation Pack 自動生成 | paper/live実績 |
| S-30 | 相関・ポートフォリオタブ | S-27 |

---

## 4. 実行順序の原理 (なぜこの順番か)

1. **S-01/S-02 が最初**: どちらも半日仕事だが、「CIの緑」と「Action Queueの静粛」は
   以後すべてのタスクの検証コストを下げる。監視の信号品質は複利で効く。
2. **S-03 (イベント履歴) が研究側の最優先**: docs/09 §1 の ROI 原理は「今日から貯めないと
   手に入らないデータ」を最優先とした。イベント履歴はその**逆** — いつでも取れるのに
   取っていないせいで、P0シード2件と docs/14 Phase 3 の全てが停止している。最大のボトルネック。
3. **アダプタ (S-10〜S-13) は1本ずつ**: SONNET-1 の教訓 (本番tickで2回スキーマ不一致発覚)
   により、複数同時投入は禁止。defillama → fred の順 (キー不要が先)。
4. **kasotubot (R3) は V1.5 と並行可能だが S-20 が関門**: 認証基盤だけ先行させ、
   kasotubot側の開発と足並みを揃える。
5. **Discovery (R4) は最後**: 単発Edge検証のスループット (R2) が立ってから量産に入るのが
   docs/04 の前提。順序を入れ替えると試行数だけ増えて FDR 制御が壊れる。

---

## 5. 「世界最高レベルの個人向けリサーチ基盤」への長期構想 (V2以降の提案)

docs/09 §5 (V3) を具体化する。**いずれも無料ファースト原則を破らない範囲で設計可能**:

1. **Regime-conditional verdicts**: 現在の verdict は全期間一枚。レジーム別 (trend×vol) の
   条件付き成績を verdict reasons に含め、「upトレンド限定ADOPT」のような部分採用を可能にする。
   全REJECT問題 (docs/17 §5-3) への統計的に誠実な緩和策。
2. **Cross-instrument 検証 (ETH横展開)**: DSL/EEP は既に instrument_id パラメタ化済み。
   BTC で screen 通過した spec を ETH で自動再検証し、頑健性の証拠とする (docs/14 #8 の D 判定
   だった transfer 検証の、Discovery を待たない最小版)。
3. **試行台帳 (n_trials ledger) の可視化**: FDR 制御の透明性を UI に出す — 「今月の試行予算
   残り」をScreen Config に表示。統計的誠実さを製品体験にする (docs/06 の思想の完成形)。
4. **Pack の自動品質評価**: 貼り戻し (handoff) の採用率を記録し、どの pack_kind が
   実際に研究を進めたかを測る。AI活用のROI を自己測定する基盤。
5. **Execution-aware research**: kasotubot の実行データ (S-25) が貯まったら、
   スリッページ実測分布を CostModel に還流し、バックテストのコスト仮定を実測で更新する。
   これが完成すると research→execution→research のループが閉じ、
   「バックテストと実運用の乖離」という業界共通の問題に対する個人規模での回答になる。
6. **公開可能な再現性レポート**: 再現性8点 (docs/02 §6) を Edge ごとに自動生成し、
   将来自分が (あるいは第三者が) 検証をやり直せる形で R2 に保存。研究としての価値の担保。
