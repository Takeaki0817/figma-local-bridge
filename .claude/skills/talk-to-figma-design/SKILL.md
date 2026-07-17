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
   - **プラグインはアクティブタブでしか通信できない**。対象ファイルのタブが背面に回る（別タブ・別アプリへ切替）と通信は止まる。作業ウィンドウの確保（対象タブを前面に保つ時間帯）を段取りに織り込む。
   - **接続確認はログでなく TCP 実体で行う**。リレーログの「join / broadcast 成功」は自分のクライアント（MCP・診断プローブ）を peer として数えるため誤検出する。`lsof -nP -iTCP:3055` でプラグイン由来の接続（プロセス名・ポート）が実在するかを確認するのが唯一確実。
4. **書き込み前に `get_document_info` でページ名（対象ファイルの識別子）を確認**してから着手する。複数エージェントで並行作業する場合は、座標バンドを事前に割り当てて衝突を防ぐ。ただしメッセージ到着順序は前後し得るため、重複作成の防止は「作業前のページ実態照合（トップレベル名の突き合わせ）」で担保する。
   - **複製ファイルは node ID を継承する**ため、node ID の一致はファイル同一性の証拠にならない。ファイル識別は「ページ名＋内容の照合」で行う（get_document_info はファイル名を返せない）。

## 0.5 運用標準（キャンバス設計）

1. 新規デザインは Figma の「ドラフト」に作成する（左上ロゴ → ファイル → 新規デザイン）。既存ファイルに相乗りしない。
2. コンポーネントのマスターは専用の「Components」ページに置く。無料プランは1ファイル3ページ制限があるため、ページ構成は3枚以内で計画する（例: Cover+Screens / Components / 予備）。
3. デザインカンプの標準フレームは モバイル 375×667 / デスクトップ 1366×768（幅は厳守。fullPage カンプでは高さのみコンテンツに従って拡張してよい）。
4. キャンバスの並び順は「モバイル各ページ → デスクトップ各ページ」。
5. フレーム間の間隔は 100px で統一する。

## 1. ビルドの基本形（Auto Layout ファースト）

絶対座標で並べると後の修正が全滅する。**すべてのコンテナは Auto Layout フレームにする**。

### 推奨ビルド順序

1. ルートフレームを `create_frame` で作成。この時点で layout 系パラメータを**同時に**指定する
   （layoutMode / padding* / itemSpacing / primaryAxisAlignItems / counterAxisAlignItems）。
   後から `set_layout_mode` → `set_padding` → … と分けるより呼び出し回数が半分以下になる。
   - **padding の暗黙既定値に注意（必須）**: `create_frame` / `create_component` は padding 4辺の既定値が **10** であり、layoutMode を指定して padding を省略すると全辺 10px が黙って入る（「未指定＝0」ではない）。**Auto Layout を指定する呼び出しでは padding 4辺と itemSpacing を必ず明示する**（0 にしたい時も `0` を書く）。blog-cms では省略箇所28件に謎の10pxが混入した実績がある。
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
| インスタンスの子 | インスタンス内部の子ノードは追加・削除・並べ替えが一切不可。テキストの characters 差し替えと TEXT ノードの fill 変更は可。**幾何ノード（RECTANGLE / FRAME）の fill 上書きは不可**。ただしインスタンス自身（ルート）への fill 変更・resize_node は可。構成要素が異なるバリエーションは別コンポーネントとして作る（例: ProductCard と ProductCard/Sale）。 |
| コンポーネント化と命名 | `create_component_from_node` は元ノード名を引き継ぎ、リネーム手段がない。正しい名前が必要なら `create_component`（name 指定可）で殻を作り、子を `set_parent` で移設して旧を削除する。**ノードのリネームコマンドは存在しない**（name は create 時のみ指定可）。`clone_node` も元ノードの name を引き継ぐため、名前が重要なノードは clone せず新規作成する。 |
| インスタンス内テキストの node ID | `I{instanceId};{マスター内部nodeId}` 形式。同一構造のインスタンスが多数ある場合、1体目だけ `scan_text_nodes` で実在確認し、2体目以降は ID パターンを組み立てて直接 set してよい（scan は重くタイムアウトしやすい）。 |
| ページ操作 | ページの作成・リネーム・ノードのページ間移動はツール未対応。ページ構成の変更はすべて Figma UI（親/オーナー）の作業＝**親UI依頼リストに計上**する。 |
| effects（影） | `set_effect`（自作拡張）で DROP_SHADOW 等を設定する。未実装環境（旧Community版）では設定不可＝親UI依頼リストへ、対象ノードID・shadow実値（offset/blur/color）を列挙して計上する。 |

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

### FILL/HUG/FIXED の判定基準（DOM実測から機械導出する — 感覚で決めない）

参照実装を採寸しているのだから、サイジングモードも採寸から**機械的に**決まる。ノードごとに:

1. **FILL 判定**: DOM実測で `子の幅 ≈ 親の幅 − 親のpadding左右`（±1px）なら horizontal FILL。CSS が `display:block` / flex の stretch / `width:100%` の要素は原則これに該当する。**Webのブロック要素は既定で親幅いっぱい＝Figmaでは FILL が既定**、という対応を忘れない（「広がるべき所が広がらない」失敗の大半はブロック要素を HUG/FIXED で置いたことによる）。
2. **HUG 判定**: 幅がコンテンツ量で決まる要素（インライン・fit-content・ボタン類）。2つのビューポート幅（375/1366）で採寸して**幅が親に追従して変わるなら FILL、変わらないならコンテンツ由来＝HUG** という交差検証が機械判定として最も確実。
3. **FIXED 判定**: CSS に明示の固定幅（`w-28` 等）がある時**だけ**。出典（CSSクラス名）必須。出典を書けない FIXED は判定ミスとみなす。
4. 縦方向も同型（高さが中身で決まる=HUG が大半。固定高は CSS 出典必須）。

検収では「DOM で親内幅いっぱいの要素が、Figma で親内幅より 2px 以上狭い」を FILL 漏れとして機械検出する（compliance-check の検査項目）。

### よく使うパターン

- **clipsContent は必要な所だけ**: フレームの「コンテンツを隠す」(clipsContent) は、影・フォーカスリング等の**外向き描画まで切り落とす**。既定は clipsContent=false とし、有効にするのは本当にクリップが必要な箇所（画面ルートフレーム・サムネイル画像枠・スクロール領域の再現）だけ。特に影を持つ子（カード等）を包むラッパーで有効にすると影が欠けて見える（home/375 で実害あり）。検収時は「影のあるノードの祖先に clipsContent=true が居ないか」を点検する。
- **ナビゲーションバー**: HORIZONTAL + `primaryAxisAlignItems: SPACE_BETWEEN`（ロゴ左・ナビ右）+ `counterAxisAlignItems: CENTER`
- **カード行**: HORIZONTAL + itemSpacing、各カードは子になった後 `layoutSizingHorizontal: FILL` で等幅
- **セクション**: VERTICAL + 大きめ padding（後述のスケール）+ 中身は HUG
- **ボタン**: Rectangle を使わず「小さな Auto Layout フレーム（padding 12/24, 角丸8）+ テキスト」で作る。テキスト量の変化に追従する

## 2. テキスト

`create_text` で指定できるのは fontSize / fontWeight / fontColor / name のみ。
**詳細設定は作成後に `set_text_style`（自作拡張）で当てる**:
fontFamily/fontStyle・lineHeight（`{value,unit:'PIXELS'|'PERCENT'}` or `{unit:'AUTO'}`）・
letterSpacing・textAlignHorizontal/Vertical・textAutoResize・textDecoration・textCase。
指定したパラメータだけが適用される（部分更新可）。

- 階層表現の基本は サイズ・ウェイト・色。行間は見出し 100〜120%、本文 150〜160% を既定とする。
- 既存テキストの一括変更は `set_multiple_text_contents`（1件ずつ `set_text_content` を連打しない）。

## 2.5 バリアブル・コンポーネント（自作拡張）

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
5. 画面フレームをまるごと作り直す時は、旧フレームを削除してから新規作成する（重複フレームは検収・コンポーネント化を混乱させる）

## 2.7 採寸原則（必須）

**値はスクショの目測で決めない。** 採寸値の正しさはデザイン再現の合格基準に直結する最重要ルール:

- **コードがある場合**: CSS実値（Tailwind クラス→px展開 等）または playwright-cli による実DOM採寸（`getBoundingClientRect` / `computedStyle`）を正とする。
- **コードが無い場合**（仮カンプ再現等）: 対象PNGのピクセル実測を正とする。
- 採寸値の**出典**（CSSクラス名・採寸コマンド・実測座標）をノード構築時に記録し、完了報告に含める。
- **根拠のない中間値（例: padding 10px）を使わない**。4/8px グリッドから外れる値は出典必須。
- **幅は rect（border-box）を正とする**: Web は通常 `box-sizing: border-box` であり、**CSS の width 宣言値には padding が内含される**。採寸は常に `getBoundingClientRect()` の実測幅（=border-box）を使い、CSS 宣言値やcomputedStyle の width から手計算しない。Figma の Auto Layout フレームも幅に padding を含む（border-box と同じ）ので、**rect 幅 → フレーム幅、rect幅 − padding左右 → コンテンツ領域幅**の対応で移す。max-width 系コンテナ（コンテンツ幅）はこの取り違えが起きやすい最重要点検箇所。
- **boxShadow も採寸対象**: 参照実装の boxShadow は採寸時に必ず記録し、Figma 側ダンプの `effects` と突き合わせる（比較項目に常設。「影は後回し」で台帳から恒久除外しない）。
- **ビューポート規約を最初に固定**する（標準: 1366×768 / 375×667）。min-h-screen 系画面の全高は規約で変わるため、規約を決めずに採寸・構築すると全高Δが規約差で汚染される。
- **実レンダリングを正とする**。参照コード自体のバグ（フォント link 未読込等）で記述と描画が食い違う場合は描画に合わせ、コードバグは別途報告する。
- PNG目測ベースのQAは off-by-one・行数カウント誤差で誤検出が出る。**間隔系は「同一要素の反復間隔の中央値」で測り**、算術検算（行数×ピッチ＋固定部＝全高）で裁定する。最も信頼できる指標は**フレーム全高Δ**。

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
- 大量のテキスト差し替え・clone は1メッセージ 10〜20 件に分割してバッチ実行する（1回に欲張るとタイムアウトしやすい）。

## 5. 修正・QAフロー

1. 修正指示を受けたら、対象ノードIDが既知なら直接 `set_*` / `move_node` / `resize_node`。不明なら `get_node_info` をルートに1回だけ当てて構造を把握。
2. 構造チェックの観点: テキストはみ出し（フレーム幅 < テキスト幅）/ Auto Layout 未設定コンテナ / 8の倍数から外れた spacing / 命名漏れ。
3. 削除は `delete_multiple_nodes` でまとめる。
4. **完了前の padding 全数スキャン（必須）**: 全フレームの幾何導出 padding を走査し、**「任意の1辺が 9.5〜10.5px の帯にあり、出典記録が無いもの」を全件検出**する（4辺一致だけを見ると、片軸のみ既定値が残る非対称ケースを系統的に見逃す — blog-cms で3マスター17件の取りこぼし実績）。出典のない 10 は create 時既定値の混入とみなして修正する（局所 padding は全高Δ=0 でも生き残るため、Δ検証だけでは検出できない）。単一子のセンタリングは padding で作らず primaryAxis/counterAxis=CENTER で表現する（センタリング副産物の混入自体を根絶）。
5. **運用標準の遡及チェック（修正・検収パスで必須）**: 運用標準①〜⑤（ドラフト作成／Components ページ退避／標準解像度／並び順／間隔100px）の充足を点検する。構築後に追加された標準も既存物へ遡及適用が既定。ツールで満たせない項目（ページ操作等）は**黙って対象外にせず「未充足＋親UI依頼」として計上**する。
6. 巨大ファイルの実値検証は `get_node_info` をコンテキストに流さず、**ws 直結スクリプトでディスクへ直接ダンプ**して機械処理する（§4 の PNG 保存と同じ接続方式）。

## 6. 完了報告の形式

- ルートフレームの node ID と主要セクションの node ID
- 失敗・スキップしたツール呼び出しとその理由
- ツール制約により実現できなかった指示（例: ページ操作）は「未対応」と明示する（黙って省略しない）
- 採寸値の出典（CSSクラス名・採寸コマンド・実測座標など）
- **完了前に `scripts/compliance-check.mjs` を対象ルートに実行**し、結果（padding帯/FIXED/影/クリップ/Variables/命名の○×）を完了報告に添付する。NG が残る場合は理由（出典・意図）を付す。
- **親UI依頼リストは完了条件の一部**: ツール未対応で親/オーナーのUI作業に回した項目（対象ノードID・具体値つき）は、依頼リストに載せた時点で「完了」ではない。**リストの消化（実施確認）まで検収の完了条件に含め**、未消化があれば完了報告に「未消化 N 件」と明記する。過去に「依頼リスト計上→そのまま放置→影が最後まで付かない」事故が起きている。
