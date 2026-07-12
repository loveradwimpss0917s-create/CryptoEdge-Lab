# HANDOFF — セッション間の現在地 (常に上書き更新)

> **運用規則**: 本書は「次のAIセッションが10分で現在地に立つ」ための1枚。
> 全セッションは終了時に本書を上書き更新してから push する (docs/AI_DEVELOPMENT_GUIDE.md §9)。
> 履歴は git log が持つ。経緯の詳細は docs/19 の実行ログへ。

**Last updated**: 2026-07-12 / Fable (CTO) / ガバナンス整備セッション

## Current Phase

**Phase RS1** (研究OS化 — 反復コスト最小化)。docs/18 §3 Phase RS 表 / docs/21 §7 が正典。
Phase R1 (V1 クローズアウト) は S-03 の FOMC 分を除き完了。Phase R2 未着手分より RS を優先
(docs/17 ADR-7)。

## Current Card

**S-100** (features parquet に forward return 列を追加) — **未着手**。
カードは docs/19 Phase RS 節。実装順は S-100 → S-101 → S-102 (全後続の前提)。
担当: Sonnet (Engineer)。

## Current Status

- 設計: docs/21 (Research OS 構想) + S-100〜S-110 カード起票済み (commit 22119fb)
- 運用: 本番は無人で稼働中 (ingest cron / daily / weekly)。CI・deploy とも green
- 本番ファネル (2026-07-12): edges 57 / spec 付き 7 / verdict 全REJECT / ADOPT 0
  — この状態の解釈は docs/21 §0 (正常。律速は spec 供給コスト)

## Blockers

1. **S-03 (fomc)**: FOMC 過去日程はサンドボックスから取得不可のため未投入。
   解除条件 = オーナーが検証済み日付リストを提供する、または実ネットワークのある
   セッションで federalreserve.gov から取得する (捏造禁止 — events_backfill.py のコメント参照)

## Recent Decisions (直近の設計判断)

- docs/21 制定: Research OS 構想。Phase RS を R2 未着手分より優先 (ADR-7)
- fwd_ret 列は EEP の `forward_returns_series()` 再利用・feature_defs 非登録 (ADR-8)
- 派生 Pack (dossier/improvement/finding_review) は保存せず on-demand 生成 (ADR-9)
- Fable=CTO / Sonnet=Engineer の二役体制 + 本書による引き継ぎ運用 (ADR-10)
- ADR 台帳は docs/17 §6 (全履歴はそこを見る)

## Next Action

1. (Engineer) **S-100 を実装** — docs/19 Phase RS 節のカードに従う。完了後 lake-sync.yml を
   workflow_dispatch で1回実行し fwd_ret 列を本番反映 (オーナー承認を得てから)
2. (Engineer, S-100 と独立・随時) S-110 (metric/segment 名契約テスト)
3. (CTO, 次回) S-100 受入 → S-101 着手判断

## Review Required

- 無し (docs/21 / Phase RS の方向性は 2026-07-12 オーナー指示「長期運用体制へ」で承認済み扱い)

## Open Questions

1. **本番の不正 spec 1件**: edge_version `01KWHQ6YVPW7KQRSF5PNQVBXE6` の signal_spec が
   未実装 feature `liq_long_z_24h` を参照 → on-demand run が fail-closed で失敗
   (2026-07-12 02:45, run 29177219145。設計どおりの拒否でありバグではない)。
   要判断: (a) spec を既存の `liq_notional_24h` ベースに修正するか、(b) `liq_long_z_24h`
   (清算ロング側の z-score) を registry に追加するか。(b) は S-101 カタログ整備後が楽
2. **Yahoo Finance 429 (S-92)**: User-Agent 付与で修正済みのつもりだが本番未検証。
   次回 daily tick 後に `ingest_state` (yahoo_finance stream) を確認すること
3. **S-103 の feature_requests 永続化**: v1 は応答エコーのみ (カードに明記済み)。
   Discovery の feature 需要集計と合流させる時期は RS4 レビューで再判断
