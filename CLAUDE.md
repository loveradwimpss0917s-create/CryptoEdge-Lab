# CLAUDE.md — AIセッションのエントリポイント

このリポジトリは **GitHub が唯一の情報源 (Single Source of Truth)** で運用される。
チャット履歴・過去セッションの記憶に依存してはならない。すべての設計判断・進捗・規約は
リポジトリ内に書かれており、ここに無いものは「決まっていない」と扱う。

## 最初に読む順序 (全AIセッション共通、所要10分)

1. **docs/HANDOFF.md** — 今どこにいるか (現在Phase・現在カード・ブロッカー・次アクション)
2. **docs/AI_DEVELOPMENT_GUIDE.md** — 役割分担・実装規約・禁止事項・GitHub運用
3. README.md — プロジェクト概要と設計書索引
4. 着手カードの「関連docs」列に挙がる設計書 (docs/19 のカードが指す)

## 役割

- **Fable = CTO / Architect**: 設計・監査・ADR・カード起票。コードは書かない (原則)
- **Sonnet = Senior Software Engineer**: docs/19 のカードを実装。設計変更はしない (原則)

詳細と例外規定: docs/AI_DEVELOPMENT_GUIDE.md §1

## 検証コマンド

```
pnpm turbo run typecheck test lint          # TS 全パッケージ (必須、全緑で完了)
cd research && uv run pytest                # Python (research/ 変更時は必須)
```

## 絶対規則 (詳細は docs/AI_DEVELOPMENT_GUIDE.md §5)

- D1 への直接 INSERT 禁止 (edge/eval 作成は必ず API 経由)
- DSL に eval 文字列を追加しない (非チューリング完全は意図)
- データの捏造禁止 (取れないデータは「無い」と記録する — FOMC日程の前例)
- 作業終了時に docs/HANDOFF.md を必ず更新してからコミット
