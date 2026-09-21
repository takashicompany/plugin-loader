# even-loader

Even Realities G2 / Even Hub のプラグイン開発用「ローダー」プラグイン。

## 目的

Even Hub のプラグイン開発では、開発中プラグインの dev server に接続するたびに QR コードのスキャンが必要になる。
このローダーを一度スマホの Even アプリにインストール (最終的には .ehpk として) しておけば、

1. ローダーを開く
2. 登録済みの開発中プラグイン (dev server) の一覧から選ぶ
3. WebView がその dev server へトップレベル遷移 (`window.location.assign(url)`)

という流れで、QR の再スキャンなしに開発中プラグインを切り替えられる。

## 構成

- `loader/` — ローダー本体 (Even Hub web app)。ポート 5178。
- `sample-app/` — 切り替え検証用のサンプル「開発中プラグイン」。ポート 5183。
  - 遷移後も bridge (G2 レンズ描画・イベント) が動くかを確認するためのアプリ。
    bridge 呼び出し結果をすべてスマホ画面のログに出す。
- `proxy/` — シム注入リバースプロキシ。開発中プラグインの dev server に
  **一切手を入れずに** シムを注入する (後述)。

いずれも Vanilla TypeScript + Vite。フレームワークなし。

## セットアップ

```
cd loader && npm install
cd sample-app && npm install
```

またはリポジトリルートで `npm run install:all`。

## 開発フロー

1. **両方の dev server を起動する**

   ```
   cd loader && npm run dev        # http://0.0.0.0:5178
   cd sample-app && npm run dev    # http://0.0.0.0:5183
   ```

2. **QR でローダーを起動する**

   ```
   cd loader && npm run qr         # evenhub qr --http --port 5178
   ```

   表示された QR をスマホの Even アプリでスキャンするとローダーが開く。

3. **接続先を追加する**

   ローダーのスマホ画面のフォームに、開発中プラグインの dev server を登録する。
   - 名前: 例 `sample-app`
   - URL: `http://<PCのIP>:5183` のような http:// / https:// で始まる絶対URL
   - 一覧は bridge の localStorage とブラウザの localStorage の両方に保存される
     (インストール済み .ehpk の WebView ではブラウザ側 localStorage が消えるため、bridge 側が本命)。

4. **切り替える**

   - スマホ画面: 各エントリの「接続」ボタン
   - G2 レンズ: スクロールで選択 → タップで接続 (ダブルタップでローダー終了)

   どちらも `location.assign(url)` で WebView ごと遷移する。以降は遷移先の
   開発中プラグインがそのまま動く。ローダーに戻るには、遷移先アプリ側で
   `history.back()` するか (sample-app の「ローダーに戻る」ボタン)、
   Even アプリでプラグインを開き直す。

## ダブルタップでローダーへ戻る (シム注入)

Even Hub の審査要件により、プラグインはルート画面のダブルタップで
`shutDownPageContainer(1)` (OS 終了ダイアログ) を呼ぶのが通例。
ローダーから開いた開発中プラグインでは、これを横取りして
`history.back()` (ローダーへ戻る) に差し替える。**プラグイン側のソース変更は不要。**

### 仕組み

- ローダーは接続時に URL へ `?even_loader=1` を付けて遷移する
  (保存された接続先 URL には付けない。遷移時にだけ付与する)。
- 遷移先に注入された `loader/public/even-loader-shim.js` がこのパラメータを検知して
  sessionStorage にフラグを保存し、URL からはパラメータを除去する
  (SPA 内遷移・リロードをまたいでも有効のまま)。
- シムは SDK 単例 `window.EvenAppBridge` の `shutDownPageContainer` メソッドをラップする
  (SDK がまだ初期化前なら `evenAppBridgeReady` イベントを待って一度だけラップ)。
  - `exitMode === 1` (終了ダイアログ) の呼び出しのみ `history.back()` に差し替え。
    それ以外の mode・引数は元メソッドへ透過委譲。戻り値は元 API と同じ
    `Promise<boolean>` 契約を維持。
  - 履歴が無い / back() で遷移しなかった場合は本来の終了処理へフォールバック。
    back() 進行中の再入 (多重ダブルタップ) も本来の終了処理へ委譲。
  - DOUBLE_CLICK イベント自体には触れない (SDK のイベント購読は複数共存するため、
    リスナー追加では既存側の終了処理を止められない)。
- **createStartUpPageContainer → rebuildPageContainer 変換 (実機の重なり対策)**:
  ホスト側のプラグインセッションは、ローダーからのトップレベル遷移をまたいで
  同一のまま。`createStartUpPageContainer` はセッションにつき 1 回きりの API
  (2 回目は invalid で拒否。実機ではローダーの 4 コンテナと遷移先のコンテナが
  重なって表示される) なので、**ローダー経由確定** (`?even_loader=1` /
  sessionStorage) の場合のみ、遷移先プラグインの初回 create を
  `rebuildPageContainer` (全コンテナ置き換え・フィールド構成は create と同一) に
  変換する。戻り値は create の契約 (`StartUpPageCreateResult`) に写像
  (true→0/false→1)。2 回目以降の create は素通し。
  プロキシ URL を QR 等で直接開いた場合 (パラメータ無し) は新規セッションなので
  変換しない (ダブルタップ差し替えのみ有効)。
- Even Hub から直接開いた場合 (パラメータ無し) はシムは何もしないので、
  通常の終了ダイアログ挙動のまま。
- ローダー側は `pageshow` (bfcache 復元) を復帰入口として `location.reload()` し、
  通常ロード経路 (boot) でブリッジ再接続とレンズ再描画を行う
  (bfcache 復元のままだとホストとのブリッジ経路が死んでいることがある。
  evenhub-simulator 0.7.3 で実測)。
- **復帰後のローダーの初回描画は rebuildPageContainer** (対称の重なり対策)。
  復帰時はセッションに遷移先プラグインのコンテナが残っているため、create では
  置き換えられない。復帰判定フラグは 3 経路で永続化する:
  pageshow→reload 直前の sessionStorage (最有力) / 遷移直前の sessionStorage /
  遷移直前の bridge.setLocalStorage (.ehpk オリジンの sessionStorage が
  履歴復帰で生きているか不明なための二重化)。boot で読んだら即クリアし、
  フラグが stale で rebuild が拒否された場合は create にフォールバックする。

### 自分の開発中プラグインで使う (vite.config.ts に 1 行)

`tools/even-loader-inject.ts` の Vite プラグインが、dev server の返す index.html に
シムをインライン注入する (`apply: 'serve'` なので build 成果物には入らない)。

```ts
// 開発中プラグインの vite.config.ts
import { evenLoaderInject } from '../even-loader/tools/even-loader-inject'

export default defineConfig({
  plugins: [evenLoaderInject()],
})
```

参照実装は `sample-app/vite.config.ts`。sample-app 本体は通常どおり
「ダブルタップ → shutDownPageContainer(1)」を呼ぶだけで、シムの横取りにより
ローダーへ戻る (= 無改変プラグインでも成立することの証明)。

Vite を使っていないプラグインは、index.html に手動で
`<script src=".../even-loader-shim.js"></script>` を足すか、シム内容をインラインで貼る。
(シムはローダー dev server の `http://<host>:5178/even-loader-shim.js` でも配信される)

### プロダクト無改変で使う (シム注入リバースプロキシ)

`proxy/` は、開発中プラグインの dev server の手前に立つ HTML 書き換えプロキシ。
**プラグインのリポジトリには一切手を入れない** (vite.config.ts の 1 行すら不要)。
Vite 以外の dev server にも効く。上記 Vite プラグイン方式と併存する代替手段で、
どちらを使ってもよい (両方が同居しても二重ラップはしない)。

```
npm --prefix proxy install   # 初回のみ (リポジトリルートで npm run install:all でも可)
npm run proxy                # リポジトリルートで実行 (実体: node proxy/server.ts)
```

- 設定は `proxy/targets.json`。`{ name, target, port }` の配列で、1 エントリにつき
  1 リスナーが 0.0.0.0 に立つ。環境変数 `EVEN_LOADER_PROXY_TARGETS` で設定ファイルの
  パスを差し替えられる (E2E テストが稼働中のプロキシと衝突せず別インスタンスを
  立てるために使用)。

  ```json
  [
    { "name": "external-app", "target": "http://127.0.0.1:5173", "port": 6173 },
    { "name": "sample-app", "target": "http://127.0.0.1:5183", "port": 6183 }
  ]
  ```

- **ポート規約: プロキシポート = ターゲットポート + 1000** (5173 → 6173)。
- 仕組み:
  - `text/html` レスポンスの `<head>` 直後に
    `<script>window.__EVEN_LOADER_FROM_PROXY=1</script><script src="/__even-loader/shim.js"></script>`
    を注入する (シムはこのフラグでも有効化される。URL パラメータ不要)。
    圧縮対応の代わりに Accept-Encoding を落として上流に非圧縮で返させ、
    Content-Length を再計算する。
  - HTML 以外のレスポンスはバイト同一で素通し。WebSocket (Vite HMR) も透過転送。
  - Host ヘッダはターゲットに書き換える (changeOrigin 相当) ため、
    `allowedHosts` を設定していない dev server でも通る。
  - `/__even-loader/shim.js` はプロキシ自身が配信する。実体は
    `loader/public/even-loader-shim.js` をリクエスト毎に読む (single source of truth)。
  - ターゲット未起動時はクラッシュせず 502 の日本語エラーページを返す。
  - **リモートログ** `/__even-loader/log`: 実機の WebView console は見えないため、
    (1) プロキシ経由ページには console 転送スクリプトが注入され、
    (2) ローダー本体 (.ehpk オリジン) も自身のログを CORS 越しに POST してくる。
    受信ログは stdout とリングバッファに残り、`curl http://<host>:6173/__even-loader/log`
    で直近分を閲覧できる。
- **ローダーに登録する URL はプロキシ側のオリジン** (例 `http://192.168.1.10:6173`)。
  ターゲット (5173) を直接登録するとシムは注入されない。
  インストール済み .ehpk のローダーから使う場合は、`loader/app.json` の
  network whitelist にプロキシ側オリジンが入っている必要がある (0.3.0 で
  6173/6183 を追加済み)。
- 注意: 遷移先 origin がプロキシになるため、プラグインが origin 依存の処理を
  している場合は挙動が変わりうる。

## E2E テスト (実機なし検証)

`tools/e2e_return.py` が Playwright (chromium) 上で偽 Even ブリッジ
(`window.flutter_inappwebview.callHandler`) を注入し、
「ローダー → sample-app 遷移 → ダブルタップ → ローダー復帰」を検証する。

```
python3 tools/e2e_return.py
```

- dev server (5178/5183) は未起動なら自動で起動・終了する。

プロキシ経路の E2E は `tools/e2e_proxy.py`:

```
python3 tools/e2e_proxy.py
```

- sample-app (5183) + プロキシ (6183/6173) を自動起動し、
  HTML 注入 / パラメータ無し有効化 / 二重注入 (Vite プラグイン併用) の単一ラップ /
  ダブルタップ横取り→back() / 非 HTML アセットのバイト同一素通し /
  Vite HMR WebSocket の 101 アップグレード / ターゲット未起動時の 502 を検証する。

外部プロダクト用テストは `EXTERNAL_APP_DIR` に対象リポジトリ、
`EVEN_SIMULATOR_PATH` にシミュレータの `bin/index.js` を指定する。

実プロダクト (無改変) での検証は `tools/e2e_external_app_proxy.py`:

```
python3 tools/e2e_external_app_proxy.py
```

- 外部プロダクトの dev server (5173) を起動するだけで一切改変せず、プロキシ (6173) 経由の
  シム注入・allowedHosts 回避 (Host 書き換え)・ダブルタップ復帰を Playwright と
  公式シミュレータ (xvfb) の両方で検証する。スクリーンショットと console ログは
  `tools/e2e-out/` に出力される。
- SDK 0.0.13 の実プロトコル (実測):
  - Web→App: `flutter_inappwebview.callHandler('evenAppMessage', '{"type":"call_even_app_method","method":"shutDownPageContainer","data":{"exitMode":1}}')`
  - App→Web: `window._listenEvenAppMessage({type:'listen_even_app_data', method:'evenHubEvent', data:{type:'sysEvent', jsonData:{eventType:3}}})` (3 = DOUBLE_CLICK)
  - ハンドシェイク不要。`window.flutter_inappwebview` が存在すれば
    `waitForEvenAppBridge()` は解決し、各メソッドは `Promise.resolve(true)` 程度の応答で足りる。

## 公式シミュレータでの検証

`@evenrealities/evenhub-simulator` (0.7.0+) には HTTP 自動化 API があり、
ヘッドレス環境でも `xvfb-run` 経由で起動できる (GUI は仮想ディスプレイに出るだけ)。

```
xvfb-run -a evenhub-simulator 'http://127.0.0.1:5178/e2e-seed.html?name=sample-app&url=http://127.0.0.1:5183' --automation-port 9898
curl -X POST http://127.0.0.1:9898/api/input -d '{"action":"click"}'         # 接続
curl -X POST http://127.0.0.1:9898/api/input -d '{"action":"double_click"}'  # ローダーへ戻る
curl http://127.0.0.1:9898/api/console                # webview の console ログ
curl http://127.0.0.1:9898/api/screenshot/glasses -o glasses.png
```

- `loader/public/e2e-seed.html` は検証用の接続先シード投入ページ
  (`?name=...&url=...` を localStorage に書いてローダーへ replace 遷移)。
- シミュレータ (WebKitGTK) では back() が bfcache 復元になり、復元後は
  ブリッジ経路が死ぬことを実測済み → ローダーの pageshow リロードで解決している。

## .ehpk の作成

```
cd loader && npm run pack     # dist をビルドして even-loader-<version>.ehpk を生成
cd sample-app && npm run pack # even-loader-sample-<version>.ehpk (検証用・任意)
```

バージョンは各 `app.json` の `version` から読まれる。

### network whitelist について (重要)

`loader/app.json` の `permissions` → `network` → `whitelist` には、
**接続先 dev server のオリジンを追加してから pack すること**。
現在はプレースホルダ (`http://192.168.1.10:5178` / `http://192.168.1.10:5183`) が
入っているので、自分の PC の IP・ポートに書き換える。

トップレベル遷移 (`location.assign`) に whitelist が適用されるかは**未検証**。
適用されない可能性もあるが、保険として接続先オリジンを whitelist に入れておく。

## /download/ehpk

loader の dev server (と preview server) には、pack 済みの .ehpk をダウンロードする
ルートがある。

```
http://<host>:5178/download/ehpk
```

- `loader/` 直下の `even-loader-*.ehpk` のうち最新 (semver 最大、パース不能なら mtime 最新) を
  `Content-Disposition: attachment` で返す。
- 1 つも無い場合は 404 と JSON (`run: npm run pack` のヒント) を返す。
- スマホから直接ダウンロードして Even アプリに読み込ませる用途を想定。

## 実機検証チェックリスト (ローカルでは未検証の点)

ローカルで検証済みなのは typecheck / build / pack / dev server / /download/ehpk まで。
以下は実機 (Even アプリ + G2) でしか確認できない。

- [ ] QR からローダーを開き、G2 レンズに「Even Loader」+ 接続先一覧が表示されるか
- [ ] G2 スクロールでカーソル移動、タップで接続、ダブルタップで終了ダイアログが出るか
- [ ] 「接続」で sample-app へ遷移し、遷移直前にレンズへ「Connecting: <name>...」が出るか
- [ ] **トップレベル遷移 (`location.assign`) に network whitelist が適用されるか**
      (whitelist 外の URL への遷移がブロックされるかどうか。適用される場合、
      接続先は必ず whitelist に入れてから pack する必要がある)
- [ ] **遷移後 (sample-app) でも bridge が動作するか**
      — sample-app の画面で `waitForEvenAppBridge: OK` が出るか、
      G2 タップでカウンターが増えるか (bridge 呼び出しログで自明になるようにしてある)
- [ ] sample-app の「ローダーに戻る」(`history.back()`) でローダーに戻れるか、
      戻った後にレンズが再描画されるか
- [ ] インストール済み .ehpk のローダーの Origin 表示 (ステータス欄) が何になるか
      (file:// 等。ブラウザ localStorage が遷移/再起動をまたいで消えるかの診断材料)
- [ ] bridge.setLocalStorage に保存した接続先一覧が、遷移・アプリ再起動をまたいで残るか
- [ ] FOREGROUND_EXIT → ENTER (他アプリへ切替→復帰) 後にレンズが再生成されるか
- [ ] .ehpk としてインストールしたローダーからの遷移でも上記が全て成り立つか
      (dev server 起動のローダーと挙動が違う可能性がある)
- [ ] **シム経由の「ダブルタップでローダーへ戻る」が実機でも成立するか**
      (evenhub-simulator と Playwright 偽ブリッジでは検証済み。
      実機 WebView の back() が bfcache 復元かフルリロードか、
      復元時にローダーの pageshow → reload → レンズ再描画が走るか)
- [ ] 戻った後の実機レンズ表示が正しく再描画されるか
      (シミュレータでは初回描画フレームが旧フレームで上書きされる現象があり、
      1秒後の再送で対処済み。実機で同様の現象が出るか)

※ ローダー本体の挙動が変わったため、インストール用 .ehpk は app.json の
   version を上げて pack し直す必要がある (未実施)。

## 参考

- Even Hub docs: https://hub.evenrealities.com/docs

## 開発サーバーの公開範囲

このツールは信頼できる開発用ネットワークで使用する。開発サーバーとプロキシは
全ネットワークインターフェースで待ち受けるため、インターネットへ直接公開しない。
プロキシは接続先の console 出力を転送し、`/__even-loader/log` では認証なしで
ログを閲覧できる。ログに認証情報や個人情報を出力しないこと。

`loader/app.json` の IP は例示用。pack 前に自分の環境へ書き換え、個人の接続情報を
コミットしない。プロキシの個別設定には Git 管理外の `proxy/targets.local.json` を使い、
`EVEN_LOADER_PROXY_TARGETS=proxy/targets.local.json npm run proxy` で起動できる。

アイコン候補の参照元とライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。
