// even-loader-shim.js
//
// Even Loader から開かれた開発中プラグインに注入するシム。プラグイン側のソース変更は不要。
//  1. ルート画面のダブルタップでプラグインが呼ぶ shutDownPageContainer(1) (OS終了ダイアログ) を
//     横取りして history.back() でローダーへ戻す。
//  2. ローダー経由 (?even_loader=1 / sessionStorage) で開かれた場合は、プラグインの最初の
//     createStartUpPageContainer を rebuildPageContainer に変換する。
//     根拠 (notes/docs/page-lifecycle.md + SDK 0.0.13 d.ts):
//       - createStartUpPageContainer はホスト側プラグインセッションにつき 1 回きり
//         ("Must be called exactly once"。2 回目は invalid(1) で拒否 ~2.1s、実測)。
//         ローダーからのトップレベル遷移はホストから見て同一セッションのままなので、
//         ローダーが既に create 済み → プラグインの create はコンテナを置き換えられず
//         実機ではローダーの 4 コンテナと重なって表示される。
//       - rebuildPageContainer は「全コンテナを破棄して作り直す」全置き換え API で、
//         フィールド構成は create と同一 (containerTotalNum/listObject/textObject/imageObject。
//         widgetId は create 専用で bridge が自動注入するため引き継がない)。
//     戻り値契約: create は Promise<StartUpPageCreateResult> (0=success/1=invalid...)、
//     rebuild は Promise<boolean> なので true→0 / false→1 に写像して返す。
//     2 回目以降の create 呼び出しは素通し (通常のアプリは 1 回しか呼ばない)。
//
// 有効化条件 (いずれか):
//   - URL に ?even_loader=1 が付いている (ローダーが遷移時に付与する)
//   - または sessionStorage にフラグが残っている (SPA 内遷移・リロード対策)
//   - または window.__EVEN_LOADER_FROM_PROXY === 1 (proxy/server.ts が HTML 注入時に
//     直前の inline script で立てるフラグ。プロキシ経由アクセスは常に有効)
// どれでもなければ何もしない (Even Hub から直接開いた場合は通常の終了ダイアログのまま)。
//
// 二重注入対策: Vite プラグイン注入とプロキシ注入が同居しても、先に有効化された
// インスタンスだけがラップする (window.__evenLoaderShim を単一状態として使う)。
//
// 仕組み (SDK 0.0.13 で実行時確認済みの事実に基づく):
//   - SDK は単例を window.EvenAppBridge に公開し、ready 時に 'evenAppBridgeReady' を発火する。
//     イベント発火時点で window.EvenAppBridge は代入済み。
//   - waitForEvenAppBridge() が返すのも同じ単例なので、インスタンスの
//     shutDownPageContainer をラップすればどちらの参照経由の呼び出しも横取りできる
//     (プロトタイプメソッドは writable/configurable)。
//   - DOUBLE_CLICK イベント自体には触れない (onEvenHubEvent は DOM リスナーベースで
//     複数共存し、追加リスナーでは既存側の終了処理を止められない)。
//   - shutDownPageContainer(exitMode?) は引数省略時 exitMode=0。ローダー経由ページでは
//     exitMode 0 (即時終了) / 1 (終了ダイアログ) の両方を横取りしてローダーへ戻す。
;(function () {
  'use strict'

  var TAG = '[even-loader-shim]'
  var PARAM = 'even_loader'
  var FLAG = 'even_loader_opened_from_loader'
  // back() でページが破棄されなかった場合に本来の終了処理へフォールバックするまでの猶予
  var BACK_FALLBACK_MS = 800

  // ─── 有効化判定 ───────────────────────────────────────────────
  // viaLoader: ローダーからの遷移が確定している (?even_loader=1 は ローダーだけが付ける)。
  //            この場合のみ create→rebuild 変換を行う (ローダーが create 済みのため)。
  // プロキシフラグ単独 (QR 等でプロキシ URL を直接開いた場合) は新規セッションの
  // 可能性があるので、ダブルタップ差し替えのみ有効化し create はそのまま通す。
  var viaLoader = false
  try {
    var url = new URL(window.location.href)
    if (url.searchParams.get(PARAM) === '1') {
      sessionStorage.setItem(FLAG, '1')
      // プラグイン自身の URL を汚さない (フラグは sessionStorage が持つ)
      url.searchParams.delete(PARAM)
      history.replaceState(history.state, '', url.toString())
    }
    viaLoader = sessionStorage.getItem(FLAG) === '1'
  } catch (e) {
    // sessionStorage が使えない環境では URL パラメータのみで判定
    viaLoader = window.location.search.indexOf(PARAM + '=1') !== -1
  }
  // プロキシ (proxy/server.ts) 経由で配信されたページは常に有効
  var active = viaLoader || window.__EVEN_LOADER_FROM_PROXY === 1
  if (!active) return

  // 既に別経路 (Vite プラグイン / プロキシ) のシムが有効化済みなら二重ラップしない
  if (window.__evenLoaderShim) return

  console.log(TAG + ' 有効: 終了要求 (exitMode 0/1) を history.back() (ローダーへ戻る) に差し替えます'
    + (viaLoader ? ' / 初回 createStartUpPageContainer を rebuildPageContainer に変換します' : ''))
  var state = {
    active: true,
    viaLoader: viaLoader,
    wrapped: false,
    intercepted: 0,
    returning: false,
    createConverted: 0,
    resent: 0,
  }
  window.__evenLoaderShim = state

  // 変換 rebuild 送信後、アプリ自身の後続描画がこの時間内に観測されなければ
  // 変換ペイロードを一度だけ再送する (実機で遷移直後の初回フレームがホスト側で
  // 取りこぼされる対策)。テストから window.__EVEN_LOADER_SHIM_RESEND_MS で調整可能。
  var RESEND_MS =
    typeof window.__EVEN_LOADER_SHIM_RESEND_MS === 'number' && window.__EVEN_LOADER_SHIM_RESEND_MS > 0
      ? window.__EVEN_LOADER_SHIM_RESEND_MS
      : 600

  // ─── createStartUpPageContainer → rebuildPageContainer 変換 ──
  // ローダーがこのセッションで既に createStartUpPageContainer を呼んでいるため、
  // プラグインの初回 create をそのまま通すと実機ではコンテナが置き換わらず重なる。
  // rebuild は全コンテナ置き換え (page-lifecycle.md) なので初回のみ変換する。
  function wrapCreate(bridge) {
    if (!viaLoader) return
    if (typeof bridge.createStartUpPageContainer !== 'function') return
    if (bridge.createStartUpPageContainer.__evenLoaderWrapped) return
    if (typeof bridge.rebuildPageContainer !== 'function') return
    var originalCreate = bridge.createStartUpPageContainer
    var originalRebuild = bridge.rebuildPageContainer
    var converted = false
    var appDrew = false // 変換後にアプリ自身が後続描画を行ったか (再送ガード)

    // アプリ自身の後続描画呼び出しを観測する透過ラッパ。
    // 変換/再送は originalRebuild を直接呼ぶため観測に混ざらない。
    var watchMethods = ['rebuildPageContainer', 'textContainerUpgrade', 'updateImageRawData']
    for (var w = 0; w < watchMethods.length; w++) {
      ;(function (name) {
        var orig = bridge[name]
        if (typeof orig !== 'function' || orig.__evenLoaderObserved) return
        var observer = function () {
          appDrew = true
          return orig.apply(bridge, arguments)
        }
        observer.__evenLoaderObserved = true
        try { bridge[name] = observer } catch (e) { /* 観測できなくても機能は損なわない */ }
      })(watchMethods[w])
    }

    var wrappedCreate = function (container) {
      if (converted) return originalCreate.apply(bridge, arguments)
      converted = true
      // RebuildPageContainer と共通のフィールドのみ引き継ぐ
      // (widgetId は create 専用・bridge 自動注入のため渡さない)
      var payload = {}
      var keys = ['containerTotalNum', 'listObject', 'textObject', 'imageObject']
      for (var i = 0; i < keys.length; i++) {
        if (container && container[keys[i]] !== undefined) payload[keys[i]] = container[keys[i]]
      }
      state.createConverted++
      console.log(TAG + ' createStartUpPageContainer を rebuildPageContainer に変換 (ローダーのコンテナを全置き換え)')
      // 実機対策: 遷移直後の初回フレームがホスト側で取りこぼされることがあるため、
      // RESEND_MS 以内にアプリ自身の後続描画が無ければ変換ペイロードを一度だけ再送する。
      setTimeout(function () {
        if (appDrew) {
          console.log(TAG + ' 後続描画を観測したため変換 rebuild の再送はスキップ')
          return
        }
        state.resent++
        console.log(TAG + ' 後続描画が ' + RESEND_MS + 'ms 無いため変換 rebuild を再送 (初回フレーム取りこぼし対策)')
        try {
          originalRebuild.call(bridge, payload).then(
            function (ok) { console.log(TAG + ' 再送 rebuild 結果=' + ok) },
            function (err) { console.log(TAG + ' 再送 rebuild 失敗: ' + err) }
          )
        } catch (e) {
          console.log(TAG + ' 再送 rebuild 例外: ' + e)
        }
      }, RESEND_MS)
      return originalRebuild.call(bridge, payload).then(
        function (ok) {
          console.log(TAG + ' 変換 rebuild 結果=' + ok)
          // StartUpPageCreateResult 契約に写像: true→0 (success) / false→1 (invalid)
          return ok ? 0 : 1
        },
        function (err) {
          console.log(TAG + ' rebuildPageContainer 変換呼び出しが失敗: ' + err)
          return 1
        }
      )
    }
    wrappedCreate.__evenLoaderWrapped = true
    try {
      bridge.createStartUpPageContainer = wrappedCreate
      console.log(TAG + ' createStartUpPageContainer をラップしました (初回のみ rebuild へ変換)')
    } catch (e) {
      console.log(TAG + ' createStartUpPageContainer の差し替えに失敗: ' + e)
    }
  }

  // ─── shutDownPageContainer ラップ ────────────────────────────
  function wrapBridge(bridge) {
    if (!bridge || typeof bridge.shutDownPageContainer !== 'function') return false
    wrapCreate(bridge)
    if (bridge.shutDownPageContainer.__evenLoaderWrapped) return true
    var original = bridge.shutDownPageContainer
    var wrapped = function (exitMode) {
      // ローダー経由ページの終了要求 (exitMode 0=即時終了 / 1=終了ダイアログ) を
      // どちらも横取りしてローダーへ戻す。それ以外の値は透過委譲。
      if (exitMode !== 1 && exitMode !== 0 && exitMode !== undefined) return original.apply(bridge, arguments)
      // 再入防止: back() 進行中の多重ダブルタップは本来の終了処理へ委譲
      if (state.returning) {
        console.log(TAG + ' 復帰処理中の再入 → 本来の終了処理へ委譲')
        return original.apply(bridge, arguments)
      }
      // 直前の履歴 entry が存在しない場合は戻れないのでフォールバック
      if (history.length <= 1) {
        console.log(TAG + ' 履歴が無いため本来の終了処理へフォールバック')
        return original.apply(bridge, arguments)
      }
      state.returning = true
      state.intercepted++
      console.log(TAG + ' shutDownPageContainer(' + (exitMode === undefined ? 0 : exitMode) + ') を横取り → history.back()')
      // back() でページが離れなければ (履歴切れ等) 本来の終了処理へフォールバック
      var args = arguments
      var timer = setTimeout(function () {
        console.log(TAG + ' back() で遷移しなかったため本来の終了処理へフォールバック')
        state.returning = false
        original.apply(bridge, args)
      }, BACK_FALLBACK_MS)
      window.addEventListener('pagehide', function () { clearTimeout(timer) }, { once: true })
      history.back()
      // 元 API と同じ Promise<boolean> 契約を維持
      return Promise.resolve(true)
    }
    wrapped.__evenLoaderWrapped = true
    try {
      // インスタンスへの own プロパティ代入でプロトタイプメソッドをシャドウする
      bridge.shutDownPageContainer = wrapped
    } catch (e) {
      console.log(TAG + ' shutDownPageContainer の差し替えに失敗: ' + e)
      return false
    }
    state.wrapped = true
    console.log(TAG + ' EvenAppBridge.shutDownPageContainer をラップしました')
    return true
  }

  // ─── インストール ────────────────────────────────────────────
  // SDK がシムより先に初期化済みなら即ラップ。まだなら ready イベントを待って一度だけラップ。
  if (!wrapBridge(window.EvenAppBridge)) {
    window.addEventListener('evenAppBridgeReady', function onReady() {
      if (wrapBridge(window.EvenAppBridge)) {
        window.removeEventListener('evenAppBridgeReady', onReady)
      }
    })
  }
})()
