# 20. kasotubot 連携アーキテクチャ (2026-07-05, Chief Architect)

> **位置づけ**: docs/16 (SignalEvent v2 インターフェース設計) を契約層として採用し、
> その上の**接続アーキテクチャ・フィードバックループ・段階的ロールアウト**を確定する。
> docs/16 が「何を渡すか」、本書が「どう繋ぎ、どう戻し、どう安全に立ち上げるか」。
> **前提の制約**: 本設計セッションの GitHub アクセスは CryptoEdge-Lab リポジトリに
> スコープされており kasotubot のコードは未確認。そのため本書は**契約ファースト** —
> kasotubot 側は本書の API 契約に対して実装すればよく、内部実装は問わない。

---

## 1. 全体アーキテクチャ

```
┌─────────────────────── CryptoEdge Lab ───────────────────────┐
│  Research (EEP/verdict)                                       │
│    └→ ACTIVE Edge の signal_spec                              │
│  ingest Worker tick-5m                                        │
│    └→ DSL評価 → paper_signals (全状態共通の検出記録)           │
│    └→ ACTIVE Edge のみ → signal_events テーブル (配信キュー)   │
│         + marginal impact 計算 (docs/16 §3, §3.2の入力を使用)  │
│  api Worker                                                   │
│    GET  /api/v1/signals?since=      ← kasotubot が60秒ポーリング│
│    POST /api/v1/portfolio-state     ← kasotubot が状態変化時push│
│    POST /api/v1/executions          ← kasotubot が約定/決済毎push│
│         (すべて Access Service Token 認証, docs/19 S-20)       │
└───────────────────────────────────────────────────────────────┘
                    ↑ pull / ↓ push (HTTPS)
┌────────────────────────── kasotubot ──────────────────────────┐
│  Signal Poller (60s) → 冪等チェック (signal_id) → 意思決定エンジン│
│    (portfolio 制約・リスク予算・marginal impact の突き合わせ)    │
│  Execution → 取引所 → 約定結果を POST /executions              │
│  Portfolio 変化毎に POST /portfolio-state                      │
└───────────────────────────────────────────────────────────────┘
                    ↓ フィードバック (§5)
  research-weekly: live vs paper vs OOS の乖離分析 → Dossier /
  decay_investigation Pack / CUSUM → ACTIVE→PAUSED 提案
```

**ADR-5 (docs/17): pull 型を採用する理由** — Workers Free に Queues / Durable Objects が無く、
push 型 (Lab→kasotubot webhook) は kasotubot 側に常時公開エンドポイントと再送処理を要求する。
60秒ポーリング + 冪等 signal_id の at-least-once 配信が、部品数最小で「取りこぼしゼロ」を
成立させる。シグナルの時間感度は最短 horizon 30m (usdt-mint-drift) なので 60s 遅延は許容内。
将来 horizon が分単位の Edge を扱う場合のみ push 型を再検討する (V3)。

## 2. なぜ paper_signals と別テーブルか

`paper_signals` は「検証のための検出記録」(PAPER/ACTIVE 両方で書く、docs/16 §4)。
`signal_events` は「配信のためのアウトボックス」— 配信状態 (delivered_at / acked_at) を持ち、
kasotubot が消費したかを追跡する。検証記録と配信キューを混ぜると、再配信・監査・
PAPER↔ACTIVE の状態遷移時の挙動がすべて複雑化するため分離する (outbox パターン)。

## 3. docs/16 の未解決4項目への決定

| open item (docs/16 §5) | 決定 |
|---|---|
| (1) ポートフォリオ状態の入力経路 | **kasotubot が push する** (`POST /portfolio-state`)。状態のownerは執行側という原則を守る。Lab は最新スナップショットのみ保持し、シグナル発火時に marginal impact を計算する材料に使う |
| (2) correlation_to_active_portfolio の集約式 | 保有中 Edge 群との**リターン相関の絶対値加重平均** (weight = 各ポジションの名目比率)。相関行列は `edge_correlations` (research-weekly が更新)。データ不足時は null を返し、kasotubot 側は null を「不明 = 保守的に扱う」と解釈する (捏造しない原則) |
| (3) 配信トランスポート | §1 のとおり pull 型 60s ポーリング。`GET /signals?since={unix_ms}` は `emitted_at > since` の未 ack イベントを返し、kasotubot は処理後 `POST /signals/ack {signal_ids:[...]}` |
| (4) リスク単位の規約 | `marginal_exposure` = 口座資産比 (0-1)、`marginal_risk` = 想定最大損失の資産比 (horizon内の ATR×2 を代理)、`capacity_usage_delta` = Edge別容量予算 (params で定義) の消費率。すべて無次元比率に統一し、通貨額は kasotubot 側で換算 |

## 4. スキーマ設計 (実装は S-23〜S-25、ここでは契約のみ)

```sql
-- migration 0009 (S-23)
CREATE TABLE signal_events (
  signal_id     TEXT PRIMARY KEY,        -- ULID。冪等キー
  edge_id       TEXT NOT NULL,
  version_id    TEXT NOT NULL,
  ts_signal     INTEGER NOT NULL,        -- 検出時刻
  direction     TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  marginal      TEXT NOT NULL,           -- JSON: docs/16 §3 の4値 (+null許容)
  meta          TEXT,                    -- trigger_snapshot
  emitted_at    INTEGER NOT NULL,
  acked_at      INTEGER                  -- kasotubot 受領確認
);
CREATE TABLE portfolio_state (
  snapshot_id  TEXT PRIMARY KEY,
  received_at  INTEGER NOT NULL,
  positions    TEXT NOT NULL             -- JSON: [{edge_id?, instrument_id, side, notional_ratio}]
);                                       -- 最新1行のみ参照 (履歴は監査用に保持)
-- migration 0010 (S-25)
CREATE TABLE trade_executions (
  execution_id TEXT PRIMARY KEY,         -- kasotubot 発番
  signal_id    TEXT NOT NULL REFERENCES signal_events(signal_id),
  status       TEXT NOT NULL,            -- filled | rejected | closed
  ts_fill      INTEGER, px_fill REAL, qty REAL,
  fees_bps REAL, slippage_bps REAL,      -- 実測: research還流の主役
  ret_net_bps  REAL,                     -- close 時に確定
  raw          TEXT                      -- 取引所レスポンス保全
);
```

zod スキーマは `packages/schema/src/api/signals.ts` に置き、**kasotubot 側にも同スキーマの
JSON Schema を配布**する (Pack の双方向スキーマと同じ思想 — 契約はコードで共有する)。

## 5. フィードバックループ (本連携の核心)

1. **実行品質の還流**: trade_executions の実測 slippage_bps / fees_bps を research-weekly が
   集計し、Edge ごとの CostModel 仮定 (taker 4 + slip 2bps) と比較。乖離が閾値 (例: 2倍) を
   超えたら Dossier の counter_evidence に自動追記 + `improvement` Pack 生成
2. **live vs paper 乖離**: 同一 Edge の paper_signals (理論) と trade_executions (実測) の
   ret_net_bps 差 = implementation shortfall を日次系列化。CUSUM (docs/04, V2の decay 検知) の
   入力にこの系列を追加し、「エッジ自体の劣化」と「執行の劣化」を分離して警報する
3. **状態機械への接続**: CUSUM 警報 → ACTIVE Edge に `decay_investigation` Pack 自動生成 +
   Action Queue 掲載。**ACTIVE→PAUSED の遷移は必ず人間の承認** (自動停止はしない —
   docs/00 の「AIも自動化も判断はしない」原則を執行側にも適用)。ただし kasotubot 側は
   自律的なキルスイッチ (日次損失上限等) を持ってよく、その発動は executions の
   status=rejected として Lab に見える
4. **研究への還流の完成形** (docs/18 §5-5): 実測スリッページ分布を CostModel の事前分布として
   使い、以後の全バックテストのコスト仮定を実測ベースで更新する

## 6. 段階的ロールアウト (K-フェーズ) — docs/19 S-23〜S-26 の実体

| フェーズ | 内容 | 進行条件 | Lab側タスク |
|---|---|---|---|
| K-0 | 契約凍結: 本書 §3-4 + docs/16 を v1.0 とし、kasotubot 側と JSON Schema を共有 | ユーザーレビュー | (本書) |
| K-1 | signals 配信基盤: signal_events テーブル + GET /signals + ack + Service Token | S-20 | **S-23** |
| K-2 | シャドー運用: kasotubot が poll→ログのみ (発注しない)。**PAPER Edge のシグナルも
      shadow=true フラグ付きで配信対象にする** — ADOPT ゼロ (docs/17 §5-3) でも配線検証を
      先に完了させるため。30日間の配信欠落ゼロを計測 | K-1 + kasotubot poller | **S-24** |
| K-3 | フィードバック配線: POST /executions (シャドー中はダミー約定で契約検証) | K-2 | **S-25** |
| K-4 | 実発注 (最小サイズ): ACTIVE Edge 誕生後、資産の 0.5% 上限で開始 | V2-4 + ユーザー承認 | — |
| K-5 | 乖離監視の自動化: §5 の 1-3 を research-weekly に実装 | K-3 の実測30日 | **S-26** |

**受入条件 (各フェーズ)**: K-1 = token付き curl で signal 取得/ack が冪等に動く。
K-2 = 30日で `emitted かつ 未acked が5分以上残存` ゼロ件。K-3 = ダミー executions が
Dossier に表示される。K-5 = implementation shortfall が Dossier で見える。

## 7. セキュリティ・法務

- 認証は Access Service Token (ADR-2)。token は kasotubot 環境変数のみに保存、リポジトリ禁止
- `/signals` は読み取り + ack のみ、`/executions` `/portfolio-state` は追記のみ —
  kasotubot 側が侵害されても Lab の研究データを改変できない (最小権限)
- 本連携は**単一ユーザー・自己資金・自己運用**に限定する。第三者への配信を行う場合は
  投資助言該当性 (docs/10 R-J3) の法的確認を必須の先行タスクとする
- kill switch の二重化: kasotubot 側 (日次損失上限) + Lab 側 (ユーザーが Edge を
  PAUSED にすれば次tickから配信停止)

## 8. 障害モードと設計上の回答

| 障害 | 挙動 |
|---|---|
| kasotubot 停止 | signal_events に未ackが溜まるだけ。復帰後 since= で追い付く。Lab 側は影響なし |
| Lab 側 tick 欠落 | シグナル自体が生成されない = 機会損失のみ。誤発注方向には倒れない |
| 二重配信 | signal_id 冪等で kasotubot 側が dedupe (at-least-once 前提の契約) |
| portfolio-state 陳腐化 | received_at が古い場合 marginal を null で配信 (§3-2 と同じ「不明は不明と言う」) |
| 時計ずれ | since はサーバ発行の emitted_at 基準。kasotubot はレスポンス内 max(emitted_at) を次回 since に使う (自前時計を使わない) |
