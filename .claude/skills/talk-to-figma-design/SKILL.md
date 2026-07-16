---
name: talk-to-figma-design
description: >
  TalkToFigma MCP（WebSocket + Figmaプラグイン）でFigmaにデザインを生成・編集する時は必ずこのスキルを使う。
  「Figmaにデザインを作って」「LPを生成」「画面/カンプ/ワイヤーを作って」「Figmaのデザインを修正して」
  「Auto Layoutを整えて」など、Figmaキャンバスへのノード生成・レイアウト調整・テキスト編集・
  デザインQAを伴うタスク全般で発火する。ツールの正確なパラメータ制約・呼び出し順序・
  トークン節約則・デザイン品質基準を含む。
---

# TalkToFigma デザイン生成スキル

TalkToFigma MCP は Figma Plugin API を WebSocket 経由で叩く。ツールは薄いラッパーなので、
**呼び出し順序と Plugin API の制約を知っているかどうか**が成果物の品質を決める。

## 0. 接続（毎回最初に）

1. `join_channel` でプラグインUIのチャンネル名に接続する。デフォルトは `figma-local-bridge`（プラグインUIのConnectionタブで変更・永続化できる）。既定値と異なる名前を使っている場合はタスク指示に含まれる。
2. 接続確認のために `get_document_info` 等の全体read系を呼ばない（トークン浪費）。join成功メッセージで十分。
3. **注意**: プラグインのウィンドウが閉じられると即切断される。しかも `join_channel` はプラグイン不在でも成功する（サーバーがチャンネルを作るだけ）ため、切断に気づけない。**ツール呼び出しがタイムアウトしたら、リトライを重ねる前に「プラグインウィンドウが開いているか・チャンネル名が一致しているか」の確認をユーザーに依頼する。**

## 1. ビルドの基本形（Auto Layout ファースト）

絶対座標で並べると後の修正が全滅する。**すべてのコンテナは Auto Layout フレームにする**。

### 推奨ビルド順序

1. ルートフレームを `create_frame` で作成。この時点で layout 系パラメータを**同時に**指定する
   （layoutMode / padding* / itemSpacing / primaryAxisAlignItems / counterAxisAlignItems）。
   後から `set_layout_mode` → `set_padding` → … と分けるより呼び出し回数が半分以下になる。
2. 子フレーム・テキストは必ず `parentId` を指定して親に直接生やす（後からの move_node は座標系がズレやすい）。
3. 子を親に入れた**後**に `set_layout_sizing` で FILL を当てる。

### 実測済みの制約（守らないとエラー/無視される）

| 制約 | 内容 |
|---|---|
| FILL のタイミング | `layoutSizingHorizontal/Vertical: FILL` は **Auto Layout 親の子になった後のみ**設定可。create 時に指定するとエラー。 |
| HUG の対象 | HUG はフレームとテキストのみ。Rectangle には不可。 |
| SPACE_BETWEEN | `primaryAxisAlignItems: SPACE_BETWEEN` を使うと `itemSpacing` は無視される（両立しない）。 |
| counterAxisSpacing | `layoutWrap: WRAP` の時のみ有効。 |
| 軸の向き | primary軸 = layoutMode の向き（HORIZONTAL なら MIN=左/MAX=右）。counter軸はその直交。 |
| 透明フレーム | `create_frame` の fillColor は alpha=0 を渡しても白不透明になる。透明にしたいコンテナは、載る背景と同じ色（変数）を fills にバインドして擬似透明にする。 |
| COMPONENT/INSTANCE 本体のサイジング | 本体への `set_layout_sizing` は不可（対象は auto-layout フレームとテキストのみ）。サイズは `resize_node` で中身の実寸に合わせる。FIXED 高さが中身とズレると、はみ出しが clip されず白帯として露出する。 |
| インスタンスの子 | インスタンス内部の子ノードは追加・削除が一切不可（テキスト差し替え・fill 変更は可）。構成要素が異なるバリエーションは別コンポーネントとして作る（例: ProductCard と ProductCard/Sale）。 |
| コンポーネント化と命名 | `create_component_from_node` は元ノード名を引き継ぎ、リネーム手段がない。正しい名前が必要なら `create_component`（name 指定可）で殻を作り、子を `set_parent` で移設して旧を削除する。 |

### サイジングの規律（最重要）

**FIXED は意図がある時だけ。既定は HUG（コンテンツに合わせる）か FILL（コンテナに合わせる）。**

`create_frame` は width/height が必須なので、**作った直後は全ノードが FIXED になっている**。
Auto Layout にしただけでは解除されない。つまり「作りっぱなし＝ほぼ全部が意図しない固定値」になる。
子を入れ終えたら、各フレームに `set_layout_sizing` を**必ず明示的に**当てて仕上げる:

| 要素 | horizontal | vertical | 理由 |
|---|---|---|---|
| ルートフレーム | FIXED（例:1440） | HUG | 幅はカンプ仕様、高さはコンテンツ次第 |
| セクション | FILL | HUG | 親幅いっぱい・高さは中身に追従 |
| カード（等幅並び） | FILL | HUG または FILL(揃える時) | 幅は行が配分、高さは中身 |
| ボタン | HUG | HUG | **padding がサイズを決める**。height固定にすると padding が無意味になる |
| ボタン行などのラッパー | HUG | HUG | 幅固定にすると中身が見切れる |
| テキスト | （未対応・そのまま） | — | |

やりがちな失敗（実例）: ボタンに padding を設定したのに height が create 時の固定値のまま
→ padding が効いていない。ボタンを並べるラッパーの width が固定
→ 中のボタンが見切れる。**「padding や中身がサイズを決めるべき要素に FIXED が残っていないか」を完了前に必ず点検する。**

### よく使うパターン

- **ナビゲーションバー**: HORIZONTAL + `primaryAxisAlignItems: SPACE_BETWEEN`（ロゴ左・ナビ右）+ `counterAxisAlignItems: CENTER`
- **カード行**: HORIZONTAL + itemSpacing、各カードは子になった後 `layoutSizingHorizontal: FILL` で等幅
- **セクション**: VERTICAL + 大きめ padding（後述のスケール）+ 中身は HUG
- **ボタン**: Rectangle を使わず「小さな Auto Layout フレーム（padding 12/24, 角丸8）+ テキスト」で作る。テキスト量の変化に追従する

## 2. テキスト

`create_text` で指定できるのは fontSize / fontWeight / fontColor / name のみ。
**詳細設定は作成後に `set_text_style`（自作拡張・2026-07-16実装）で当てる**:
fontFamily/fontStyle・lineHeight（`{value,unit:'PIXELS'|'PERCENT'}` or `{unit:'AUTO'}`）・
letterSpacing・textAlignHorizontal/Vertical・textAutoResize・textDecoration・textCase。
指定したパラメータだけが適用される（部分更新可）。

- 階層表現の基本は サイズ・ウェイト・色。行間は見出し 100〜120%、本文 150〜160% を既定とする。
- 既存テキストの一括変更は `set_multiple_text_contents`（1件ずつ `set_text_content` を連打しない）。

## 2.5 バリアブル・コンポーネント（自作拡張・2026-07-16実装）

**デザイントークンは Figma Variables で持つ**。色・スペーシングをハードコードで散らばらせない:
1. `create_variable_collection`（例: 'Design Tokens'）→ `create_variable`（COLOR/FLOAT/STRING/BOOLEAN、名前は 'color/accent' 'space/lg' のスラッシュ階層）
2. `bind_variable` で node の fills/strokes/width/height/cornerRadius/padding系/itemSpacing 等にバインド
3. 既存の把握は `get_variables`（collectionId で絞り込み可）

**繰り返し要素はコンポーネント化**:
- 既存ノードから: `create_component_from_node`（component/instance には使えない）
- 新規: `create_component`（create_frame と同じ Auto Layout パラメータ）
- 配置: `create_component_instance`、差分: `get_instance_overrides` / `set_instance_overrides`
- カード等を3枚並べる時は「1枚作る→コンポーネント化→インスタンス2枚→テキストだけ override」が正道（clone連打より保守性が高い）

## 2.6 既存デザインの編集フロー

丸ごと上書きはしない（Figmaはマルチプレイヤー）。**read → 計画 → 差分適用**:
1. `get_node_info` を対象ルートに1回（構造・layoutSizing・現行値の把握）。ファイル全体の read はしない
2. 変更計画を立ててから `set_*` / `set_text_style` / `bind_variable` で差分適用
3. 階層の組み替えは `set_parent`（appendChild。index指定・keepPosition対応）と `reorder_children`
4. 大規模な作り直しが必要な場合のみ、新フレームを隣に生成→ユーザー確認→旧を削除（勝手に旧を消さない）

## 3. デザイン品質の既定値

指示に明示がない場合の既定:

- **スペーシング**: 8の倍数のみ（8/16/24/32/48/64/96）。セクション padding は 96/64、カード内 24〜32、要素間 8〜16。
- **タイプスケール**: 48(見出し)/32(セクション見出し)/20(カードタイトル)/16(本文)/14(補足)。
- **色**: ニュートラル基調（#FFFFFF/#F5F5F7/#1D1D1F/#6E6E73）+ アクセント1色。fontColor/fillColor は 0-1 の RGBA で渡す（255値を直接入れない）。
- **角丸**: カード12、ボタン8、入力欄8。
- **命名**: すべてのノードに意味のある `name` を付ける（"Header" "Hero" "FeatureCard-1"）。後のQA・修正で自分が助かる。

## 4. トークン節約則

- `get_document_info` / `read_my_design` / `scan_nodes_by_types` の広域read系は原則使わない。作成時に返る node ID を自分で記録して使う。
- 検証が必要な時は `get_node_info` を**対象ノード1つだけ**に使う。
- `export_node_as_image` は base64 テキストで返り巨大。使う場合は対象を絞り format PNG・低倍率で。全体スクショ用途では乱用しない。
- **PNG をファイル保存したい場合は MCP 経由では不可**（インライン画像で返る）。`ws://localhost:3055` に直接接続するスクリプトで `export_node_as_image` コマンドを送り、base64 をデコードして保存する。リクエスト形式は `src/talk_to_figma_mcp/server.ts` の `sendCommandToFigma` 準拠（`{id, type:"join"|"message", channel, message:{id, command, params:{...,commandId:id}}}`）。リレーは他クライアントのメッセージを broadcast でラップして流すため、自分の id 一致 + result 存在でフィルタする。
- エラーが出たツールは1回だけリトライ。2回失敗したら飛ばして続行し、最後にまとめて報告する。

## 5. 修正・QAフロー

1. 修正指示を受けたら、対象ノードIDが既知なら直接 `set_*` / `move_node` / `resize_node`。不明なら `get_node_info` をルートに1回だけ当てて構造を把握。
2. 構造チェックの観点: テキストはみ出し（フレーム幅 < テキスト幅）/ Auto Layout 未設定コンテナ / 8の倍数から外れた spacing / 命名漏れ。
3. 削除は `delete_multiple_nodes` でまとめる。

## 6. 完了報告の形式

- ルートフレームの node ID と主要セクションの node ID
- 失敗・スキップしたツール呼び出しとその理由
- ツール制約により実現できなかった指示（例: 行間指定）は「未対応」と明示する（黙って省略しない）
