# 11. テスト戦略

> 最重要原則: **統計エンジンが静かに間違うことが最大の失敗モード** (R-J1)。テスト予算の 50% を EEP に投じる。

## 1. レイヤ構成

| レイヤ | ツール | 対象 | CI |
|---|---|---|---|
| Unit (TS) | Vitest | アダプタ parse (純関数)、DSL 評価器、状態機械、zod スキーマ | 毎 PR |
| Unit (Py) | pytest | features 変換、EEP 各ステージ、metrics 計算 | 毎 PR |
| 統計妥当性 | pytest (専用スイート) | §3 | 毎 PR (高速版) + nightly (フル) |
| 契約テスト | Vitest + pytest 共有フィクスチャ | §4 | 毎 PR |
| 統合 | wrangler dev + Miniflare | Cron tick→ingest_tasks→D1/R2 の一連 (モック API)、/internal フロー | 毎 PR |
| E2E | Playwright | 主要フロー: 朝ループ / 昇格 / 評価実行→Dossier 反映 | main merge 時 |
| データ品質 (常時) | 本番 DQ ルール自体 | 収集の継続的検証 (テストが本番に常駐する設計) | 常時 |

## 2. アダプタテスト規約
- 各アダプタに実 API レスポンスの**録画フィクスチャ** (匿名化不要、public データ) を最低 3 種 (正常/欠損/異常値) 用意し、parse → zod → 正規化行を検証
- 外部 API 変更検知: 週次で live smoke (1 リクエスト/ソース) を実行し、スキーマ不一致を issue 化

## 3. 統計エンジンの妥当性テスト (EEP)

1. **ゴールデンデータセット**: 幾何ブラウン運動 + 既知の埋込み効果 (例: 特定条件で +50bps を注入した合成系列) を生成し、EEP が (a) 埋込み Edge を ADOPT し (b) 無効果系列を REJECT することを検証。**検出力と偽陽性率そのものをテストする**
2. **既知分布との照合**: Sharpe/Sortino/MaxDD/Wilson CI/DSR を、公刊の数値例・参照実装 (scipy/statsmodels) と 1e-9 精度で照合
3. **look-ahead 検出テスト**: 意図的に未来情報を混ぜたシグナルを流すと、PIT 検査が拒否することを検証 (ネガティブテスト)
4. **再現性テスト**: 同一 (version, dataset_hash, seed, git_sha) の 2 回実行で eval_metrics が完全一致
5. **Permutation/Bootstrap の統計的健全性**: 帰無データで p 値が一様分布に従う (KS 検定, nightly のみ)

## 4. DSL 二重実装の契約テスト
- `packages/schema/fixtures/dsl-golden.json`: {spec, 入力系列, 期待発火列} のベクトル 50+ 件
- TS 評価器 (ingest) と Py 評価器 (research) の両 CI が同一ファイルを読んで一致を検証。**このテストが落ちたら何よりも先に直す** (バックテストとペーパーの同一性が崩れるため)
- /internal API の JSON も同様に zod ↔ pydantic の共有フィクスチャで契約テスト

## 5. スキーマ・マイグレーション
- CI で「migrations を空 DB に全適用 → packages/schema の型と突合 (drizzle-kit 等で introspect 比較)」
- マイグレーションは前方のみ (down なし)。適用前に R2 バックアップ確認 (docs/12 §3)

## 6. E2E シナリオ (Playwright, シードデータ注入済み環境)
1. Today に Action が表示され、承認すると Board のカードが移動する
2. finding を昇格 → CANDIDATE が Board に現れ screen run が queued になる
3. run 完了 (モック) → Dossier に verdict と reasons が表示される
4. DQ critical 発生 → Data Health と Action Queue に反映

## 7. 非機能
- 負荷: API p95 < 300ms (KV ヒット時 < 50ms) を k6 で main merge 時に確認
- ライトハウス: Today 画面 LCP < 2.5s
