# Figma Local Bridge

ローカルで動くAIエージェント（Claude Code、Cursor、その他）が、Figma Plugin APIを通じてFigmaデザインを生成・編集できるようにします。Figma REST APIも公式のFigma MCPサーバーも使わず、コール数の制限もありません。すべてlocalhostで完結します。

## Why

公式のFigma MCPサーバーは有料シートが必要で、コール数にも制限があります。Figma Local Bridgeは代わりに**Plugin API**（追加コストなし、Figmaエディタ内で動作）を**ローカルのWebSocketリレー**経由で操作することで、AIエージェントに同等のプログラム的なキャンバス操作権限を与えます。通信はすべてローカルマシン内で完結し、外部通信は一切発生しません。

## Architecture

```
MCP server (bun)  <-->  WebSocket relay :3055  <-->  Figma plugin  <-->  Plugin API
```

- **MCP server** — Model Context Protocol経由でAIエージェントにデザインツールを公開します。
- **WebSocket relay** — MCPサーバーとFigmaプラグインを名前付きチャンネルで接続する、localhost限定のブリッジ（ポート3055）です。
- **Figma plugin** — Figmaエディタ内で動作し、Plugin APIに対してコマンドを実行します。

## Quick start

1. [Bun](https://bun.sh)をインストールし、依存関係をインストールします。

   ```bash
   bun install
   ```

2. WebSocketリレーを起動します。

   ```bash
   bun run src/socket.ts
   ```

3. Figmaデスクトップアプリでプラグインをインポートします。
   Plugins → Development → Import plugin from manifest… → `src/cursor_mcp_plugin/manifest.json` を選択。

4. AIエージェント（例: Claude Code）にMCPサーバーを登録します。同梱の`.mcp.json`はサーバーを直接起動します。

   ```json
   {
     "mcpServers": {
       "TalkToFigma": {
         "command": "bun",
         "args": ["src/talk_to_figma_mcp/server.ts"]
       }
     }
   }
   ```

5. Figmaでプラグインを実行し、**Connect**をクリックします。デフォルトのチャンネルは`figma-local-bridge`です（プラグインのConnectionタブで編集可能、リロード後も保持されます）。その後、エージェントに同じチャンネル名で`join_channel`を呼び出させます。

## Tools

MCPサーバーは、Figmaデザインの読み取り・編集のためのツールを公開しています。ドキュメント/選択状態の検査、フレーム・矩形・テキストの作成、オートレイアウトと間隔設定、塗り/線/角丸、移動・リサイズ・複製・削除、コンポーネントとインスタンスのオーバーライド、アノテーション、プロトタイプのリアクション、FigJamコネクタ、画像エクスポートなどです。

### このforkで追加した9個のツール

- `set_parent` — ノードを別のノードの子として再配置します（インデックス/位置維持を指定してappend childを実行）。
- `reorder_children` — 親ノード内の子要素の並び順を変更します。
- `set_text_style` — テキストノードの行間・字間・配置・フォントファミリー/スタイルを設定します。
- `get_variables` — ローカル変数を一覧表示します（コレクションでのフィルタも可能）。
- `create_variable_collection` — モード名を指定して変数コレクションを作成します。
- `create_variable` — スラッシュ階層の名前を持つCOLOR/FLOAT/STRING/BOOLEAN変数を作成します。
- `bind_variable` — 変数をノードのプロパティ（fills、strokes、サイズ、角丸、パディング、間隔など）にバインドします。
- `create_component_from_node` — 既存のノードをコンポーネントに変換します。
- `create_component` — オートレイアウトのパラメータと任意の名前を指定して空のコンポーネントを作成します。

### その後に追加したツール

- `set_effect` / `set_clips_content` — 影（DROP_SHADOW など）と「コンテンツを隠す」の切り替え。
- `dump_tree` — ノード（省略時は現在のページ）の実際のレイアウト（Auto Layout の向き・余白・間隔・サイズの決め方・変数の結び付け・テキストスタイル・出典の記録）を読み出します。`outputPath` でファイルに書けます。
- `ensure_pages` / `set_current_page` / `move_to_page` — ページの作成・切り替え・ページ間の移動。
- `rename_node` / `list_fonts` — レイヤー名の変更、フォントの太さの一覧。
- `export_node_as_image` に `outputPath` を追加しました（大きな画像を会話に流さずファイルに保存）。

プラグインには、スクリプトから使う `build_tree`（画面を丸ごと一度に組み立てる）、`ensure_tokens`（色変数・テキストスタイル・エフェクトスタイルの登録）、`combine_variants`、`clear_page` もあります。

### 動いているWebアプリからFigmaを組み立てる

`scripts/` のスクリプトで、実際の表示を測ってそのまま Figma に起こせます（Playwright の Chromium が必要）。

1. `node scripts/dom-extract.mjs --base http://localhost:5173 --out <dir> --screens screens.json --components <React部品名,...>` — 各画面を 375px / 1366px で開き、要素の箱・計算済みスタイル・文字・画像・SVG と画面写真を保存します。
2. `node scripts/figma-build.mjs --extract <dir> --screens screens.json --images <public/images> --src <app/src> --out manifest.json --components <部品名,...> [--state-components StatusBadge:Status] [--clean]` — Auto Layout・コンポーネント（画面幅や状態のバリアント）・色変数・テキストスタイル・エフェクトスタイルで組み立てます。各ノードには元の要素と寸法の出典が記録されます。
3. `node scripts/figma-export.mjs manifest.json <dir>` と `python3 scripts/visual-diff.py <実画面.png> <Figma.png> <比較.png>` — 実画面と見比べます。
4. `node scripts/compliance-check.mjs --manifest manifest.json` — 余白10px帯・出典のない固定サイズ・FILLの付け忘れ・縮む親の中のFILL・切れる影・変数の結び忘れ・テキストスタイル・既定のレイヤー名・画面の高さを検査します。

### 同梱のClaude Codeスキル

Claude Codeスキルが`.claude/skills/talk-to-figma-design/`に含まれています。Plugin APIの制約、呼び出し順序、トークン節約のルール、エージェント駆動のFigma操作を信頼性高く動かすためのデザイン品質のデフォルト設定をまとめています。

## Credits

[cursor-talk-to-figma-mcp](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp)（Sonny Lazuardi作、MIT）をベースに変更を加えています。`LICENSE`を参照してください。

## Disclaimer

非公式です。Figma社とは一切関係なく、承認や推奨も受けていません。
