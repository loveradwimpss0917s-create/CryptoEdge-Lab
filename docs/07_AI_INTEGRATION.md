# 07. AI 活用設計 — 「AI ハンドオフ」方式 (常時 API 不使用)

> 方針転換 (v2): AI API を常時組み込まない。**プラットフォームの仕事は「AI に渡しやすい研究データ (Research Pack) を自動生成すること」**であり、解析は研究者が必要時に Claude / ChatGPT / Gemini へ持ち込む。運用コスト ¥0。
> 原則は不変: AI は仮説生成と要約のため。Verdict 判定・数値計算には決して使わない。

## 1. なぜハンドオフ方式か

1. **コスト**: 日次ブリーフィングを LLM API で生成すると月 $5–15。年単位では無視できない。テンプレート生成 + 必要時ハンドオフなら ¥0
2. **品質**: 研究者が対話的に使う frontier モデル (Claude 等の Web UI) は、API の一撃生成より深掘り・反問ができ、研究用途ではむしろ質が高い
3. **可搬性**: 特定ベンダーの API に依存しない。渡す先は Claude でも ChatGPT でも Gemini でもよい
4. **拡張性**: Research Pack は構造化されているため、将来 API を繋ぐ場合 (§6) も同じ Pack を入力にするだけ

## 2. Research Pack — AI に渡す標準成果物

**定義**: 1 つの研究文脈 (日次状況 / 1 Edge / 1 finding / DQ 状況) を、LLM が追加説明なしで解析できる自己完結 Markdown (+ 添付 JSON/CSV)。R2 `packs/` に自動生成され、UI の **[Copy for AI]** ボタンでクリップボードへ、または .md ダウンロード。

### Pack の共通構造 (テンプレは apps/api/src/packs/ + research/packs/ で管理、prompt_version 相当の pack_version を付与)

```
1. ROLE & TASK      — 「あなたはクオンツ研究の批評者である。以下を検証し…」(用途別指示文)
2. CONTEXT          — プラットフォーム前提の最小要約 (EEP の定義、コストモデル、用語)
3. DATA             — 構造化データ (メトリクス表、CI、レジーム別成績、時系列サマリ)
4. QUESTIONS        — このPackで AI に聞くべき標準質問リスト (研究者が編集可)
5. GUARDRAILS       — 「新しい数値を創作しない」「データにない断定をしない」等
6. APPENDIX         — 生データ CSV (トレード一覧等、トークン予算内に自動トリム)
```

### Pack の種類

| pack_kind | 生成タイミング | 内容 / 標準質問の例 |
|---|---|---|
| `daily_briefing` | 毎日 (daily-light) | 市況・発火・劣化・新 findings のテンプレ生成文 + 「今日注視すべき異変は?」 |
| `edge_dossier` | full run 完了時 / 随時 | Edge 全証拠。「この Edge の反証仮説を 3 つ挙げよ」「過学習の兆候は?」 |
| `finding_review` | weekly-heavy | finding 統計 + 4 源泉タグ候補。「経済的根拠を接地できるか、できないなら接地不能と答えよ」 |
| `decay_investigation` | CUSUM 警報時 | 劣化前後の成績・レジーム・DQ 状況。「劣化原因の仮説を順位付けせよ」 |
| `dq_review` | DQ critical 時 | 異常値と同時刻の他ソース・events。「データ不良か本物の市場イベントか」 |
| `improvement` | 手動 | WATCH Edge の fail 理由 + パラメータ空間。「試行数コストを踏まえ、次に試す 1 手は?」 |
| `literature_import` | 手動 (逆方向) | ユーザーが AI で論文を要約した**結果を貼り戻す**ための入力フォーム様式 (hypothesis/rationale/evidence の JSON スキーマを Pack に同梱し、AI に「この JSON で出力せよ」と指示) |

### 重要な設計点: 双方向スキーマ

Pack には「AI からの回答をこの JSON スキーマで出力せよ」という**返信様式**を同梱する (rationale ドラフト、劣化原因ランキング等)。UI 側に貼り戻し欄があり、zod 検証を通れば `ai_outputs` (source='handoff') として記録・Dossier に添付される。**AI とのやり取りも研究記録として残る**。

## 3. 日次ブリーフィングの生成方式 (AI なしで成立させる)

daily-light (Actions) が**決定論テンプレート**で生成する:
- TL;DR はルールベース (優先度: 劣化警報 > DQ critical > 発火損益 > レジーム遷移 > 新 findings)
- 数値の文章化は定型文 (「usdt-mint-drift が 2 回発火し net +34bps」)
- 「今日やるべきこと」は Action Queue の上位 3 件をそのまま反映

AI の付加価値 (文脈解釈・異変の物語化) が欲しい日だけ、Briefing 画面の [Copy for AI] で `daily_briefing` Pack を Claude 等に渡す。**ブリーフィングの成立に AI は不要**という点が旧設計との本質的な違い。

## 4. UI 統合 (docs/06 と対応)

- 全 Dossier / finding / DQ issue / Briefing に [Copy for AI] ボタン (pack_kind 自動選択、トークン概算表示付き)
- Settings に「Pack 既定サイズ (S/M/L = 概算 4k/16k/64k トークン)」設定。L は添付 CSV を多く含む
- 貼り戻し欄 (`Paste AI response`) は JSON 検証 + プレビュー → 保存で ai_outputs へ

## 5. ローカル/無料の AI 補助 (任意、コスト 0 を崩さない範囲)

| 手段 | 用途 | 位置づけ |
|---|---|---|
| Workers AI 無料枠 (日次上限あり) | DQ issue の 3 分類など超軽量タスク | V2 で必要性を再評価。無くても成立する設計を維持 |
| ブラウザ内 BYO キー | 研究者が自分の API キーをブラウザの localStorage に置き、SPA から直接 Anthropic/OpenAI API を叩く (サーバを経由しない) | プラットフォーム費用 0 のまま「ワンクリック解析」を実現するオプション。キーはサーバに送らない |

## 6. 将来の有料拡張 (V2+ でデータ量が正当化した場合のみ)

- `packs/` の出力をそのまま LLM API に流す optional module (`ai-autopilot`): daily_briefing の自動彩色、finding_review の全件一次スクリーニング。**入力契約が Pack で固定されているため、追加は 1 モジュールで済む**
- Vectorize + embedding で過去 Dossier/Briefing の意味検索 (資料はすべて R2 に Markdown で揃っている)
- 判断基準: 「手動ハンドオフの往復が週 5 回を超え、時間コストが金銭コストを上回ったら」(docs/09 §5 の有料化トリガー表)
