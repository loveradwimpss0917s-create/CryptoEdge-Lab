# 07. AI 活用設計

> 原則 (docs/00 §3-9): **AI は仮説生成と要約、判定は統計パイプライン**。AI 出力はすべて `ai_outputs` に記録され、`draft` → 人間レビューを経る。
> 経路: api Worker → Cloudflare AI Gateway → Anthropic API (`claude-sonnet-5` 主 / 軽量タスクは `claude-haiku-4-5`)。フォールバック: Workers AI (Llama 系, 品質低下を許容する要約のみ)。

## 1. 使う場所 / 使わない場所

| 用途 | AI | 理由 |
|---|---|---|
| 日次ブリーフィング生成 | ✅ Sonnet | 数値→物語の変換は AI の得意領域。入力は構造化 JSON のみ (幻覚抑制) |
| Edge 仮説生成 (findings への rationale 提案) | ✅ Sonnet | docs/04 §1 の 4 源泉への「接地」候補を提示。採用は人間 |
| Dossier ドラフト (評価結果の文章化) | ✅ Sonnet | reasons JSON → 読める報告書 |
| データ品質異常の文脈判定 | ✅ Haiku | DQ-03 スパイクが「本物のテール」か「データ不良」かの一次スクリーニング |
| 改善提案 (WATCH Edge のパラメータ/条件付け示唆) | ✅ Sonnet | 提案は新 edge_version の draft として出力。試行数コストも明示させる |
| 文献要約 (ユーザーが貼った論文/記事 → Edge IDEA 化) | ✅ Sonnet | PDF の文献接地文化を継続する導線 |
| Verdict 判定 | ❌ | 決定論ルールのみ (docs/05 §5) |
| 数値計算・統計 | ❌ | research-worker の責務。AI に計算させない |
| シグナル生成 | ❌ | DSL 評価器のみ |

## 2. 共通実装規約

- プロンプトテンプレは `apps/api/src/ai/prompts/` にバージョン付き管理 (`prompt_version` を ai_outputs に記録)
- **入力は常に構造化データ** (メトリクス JSON、findings 行、DQ issue 行)。生の市場解説を書かせるための Web 検索は行わない (幻覚源)
- 出力は zod スキーマ強制 (JSON mode)。本文は R2 保存、D1 はメタのみ
- 月次コスト上限を settings に持ち、AI Gateway の集計で超過時は Haiku に自動格下げ → それでも超過なら停止 (Briefing はテンプレのみで生成継続)
- 見積り: Briefing 日次 ~15k in / 2k out トークン + 随時タスク → 月 $5–15 想定

## 3. 日次ブリーフィング (最重要ユースケース)

毎朝 03:00 UTC、research nightly 完了後に生成。入力 (すべて D1/R2 から機械組成):

1. 市況スナップ (価格/RV/funding/レジームラベルの変化)
2. ペーパー/ACTIVE Edge の昨日の発火・損益・CUSUM 状態
3. 新 findings 上位 5 (q 値・novelty・効果量)
4. DQ issues (open)
5. 実行待ちアクション (承認待ち遷移、再評価予定)

出力テンプレ (SCR-01 に表示):
- **TL;DR 3 行**
- **今日やるべきこと** (優先順位付き最大 3 件、各 1 クリックで該当画面へのリンク)
- 変化点の解説 (レジーム遷移・劣化警報があれば)
- 新発見の紹介 (統計値の言い換えは可、新たな数値の創作は禁止と指示)

## 4. 仮説生成の詳細 (Discovery 連携)

- 新 finding に対し「この統計パターンは docs/04 §1 の 4 源泉のどれで説明できるか。説明できないなら『接地不能』と答えよ」を強制する構造化プロンプト
- 出力: {grounding: forced_flow|mismatch|info_asymmetry|behavioral|none, rationale_draft, counter_evidence_draft, suggested_evidence_keywords}
- **「接地不能」と答えさせる選択肢を必ず与える** — AI に無理やり物語を作らせないための設計
- ユーザーが論文 PDF/URL テキストを貼ると、Edge IDEA (hypothesis/rationale/evidence 込み) のドラフトを生成する「Import from literature」機能 (SCR-04)

## 5. データ品質監視

- 日次 DQ サマリ: open issues を Haiku が分類 (「収集系の問題 / ソース側の問題 / 本物の市場イベント」) し、推奨対処を 1 行ずつ付ける
- スパイク判定: DQ-03 フラグ行に対し、同時刻の他ソース値・events を突き合わせて「corroborated (裏付けあり)」/「suspect」をラベル → suspect のみ人間へ

## 6. 将来 (V3)

- ニュース/SNS ストリームのイベント抽出 (構造化イベント→ events テーブル)
- 「研究アシスタント」対話モード: Dossier を文脈に持つ Q&A (RAG: R2 の briefings/dossiers を検索)
