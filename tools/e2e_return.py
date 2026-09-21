#!/usr/bin/env python3
"""E2E: ローダー → sample-app 遷移 → ダブルタップで history.back() 復帰 の検証。

シムの設計 (これを検証する):
  - SDK 単例 window.EvenAppBridge の shutDownPageContainer メソッドをラップする
    (シムが先に走った場合は 'evenAppBridgeReady' イベントを待って一度だけラップ)
  - exitMode === 1 の呼び出しのみ横取りして history.back()。他は元メソッドへ透過委譲
  - ローダー側は pageshow (bfcache 復元) を復帰入口としてレンズを再描画

実機なしで検証するため、Playwright (chromium) 上に偽の Even ブリッジ
(window.flutter_inappwebview.callHandler) を注入する。SDK 0.0.13 の実プロトコル:

  - Web→App: flutter_inappwebview.callHandler('evenAppMessage',
      '{"type":"call_even_app_method","method":"<method>","data":{...}}')
    どのメソッドも Promise.resolve(true) 相当の応答で解決する (ハンドシェイク不要)。
  - App→Web: window._listenEvenAppMessage(
      {type:'listen_even_app_data', method:'evenHubEvent',
       data:{type:'sysEvent', jsonData:{eventType:3}}})   # 3 = DOUBLE_CLICK_EVENT

注意: Playwright の chromium は bfcache を無効化するため、back() 後のローダーは
通常リロード (boot() 再実行) になる。bfcache 復元パス (pageshow) は
evenhub-simulator (WebKitGTK) 側の検証でカバーする。

実行:
  python3 tools/e2e_return.py
"""

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
LOADER_PORT = 5178
SAMPLE_PORT = 5183
LOADER_URL = f"http://localhost:{LOADER_PORT}"
SAMPLE_URL = f"http://localhost:{SAMPLE_PORT}"

# 偽ブリッジ: callHandler 呼び出しを window.__bridgeCalls と console に記録して true で解決。
# console 記録はページ遷移をまたいで Python 側に残るため、遷移後の検証に使う。
FAKE_BRIDGE_INIT = """
(() => {
  const calls = [];
  Object.defineProperty(window, '__bridgeCalls', { value: calls });
  window.flutter_inappwebview = {
    callHandler: (name, payload) => {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      calls.push({ name, payload: raw });
      console.log('__FAKE_BRIDGE__ ' + location.port + ' ' + name + ' ' + raw);
      return Promise.resolve(true);
    },
  };
})();
"""

DOUBLE_CLICK_MSG = {
    "type": "listen_even_app_data",
    "method": "evenHubEvent",
    "data": {"type": "sysEvent", "jsonData": {"eventType": 3}},
}


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_server(subdir: str, port: int) -> subprocess.Popen | None:
    if port_open(port):
        print(f"  (port {port} は既に稼働中 — 再利用)")
        return None
    proc = subprocess.Popen(
        ["npx", "vite", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=ROOT / subdir,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,  # npx の子 (vite) ごと killpg で確実に止める
    )
    for _ in range(100):
        if port_open(port):
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"{subdir} dev server が起動できませんでした (port {port})")
        time.sleep(0.2)
    proc.terminate()
    raise RuntimeError(f"{subdir} dev server の起動がタイムアウトしました (port {port})")


results: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((label, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {label}" + (f" — {detail}" if detail else ""))


def main() -> int:
    procs: list[subprocess.Popen] = []
    print("dev server 起動中...")
    for subdir, port in (("loader", LOADER_PORT), ("sample-app", SAMPLE_PORT)):
        p = start_server(subdir, port)
        if p:
            procs.append(p)

    # 「存在するが応答しない」接続先 (accept はされるが応答しないブラックホール)。
    # ECONNREFUSED だと chromium が即エラーページへ遷移してしまうため、
    # 実機 (WKWebView が現ページに留まる) の Connecting 固着を応答待ちで再現する。
    blackhole = socket.socket()
    blackhole.bind(("127.0.0.1", 0))
    blackhole.listen(5)
    dead_url = f"http://127.0.0.1:{blackhole.getsockname()[1]}"

    console_lines: list[str] = []
    nav_urls: list[str] = []

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context()
            ctx.add_init_script(FAKE_BRIDGE_INIT)
            page = ctx.new_page()
            page.on("console", lambda m: console_lines.append(m.text))
            page.on(
                "framenavigated",
                lambda f: nav_urls.append(f.url) if f == page.main_frame else None,
            )

            # ── 1. ローダー起動 + 偽ブリッジ接続 ────────────────────
            page.goto(LOADER_URL)
            page.wait_for_selector("#bridgeStatus:has-text('Connected')", timeout=10000)
            check("ローダー起動: 偽ブリッジで waitForEvenAppBridge が解決", True)

            loader_calls = page.evaluate(
                "window.__bridgeCalls.map(c => JSON.parse(c.payload).method)"
            )
            check(
                "ローダー: SDK がブリッジ呼び出しを実行 (createStartUpPageContainer)",
                "createStartUpPageContainer" in loader_calls,
                f"calls={loader_calls}",
            )

            # ── 1b. i18n: デフォルト英語 → 日本語切り替え ────────────
            ui_en = page.evaluate(
                "({lang: document.documentElement.lang,"
                " status: document.getElementById('bridgeStatus').textContent,"
                " add: document.getElementById('formSubmit').textContent,"
                " head: document.querySelector('#statusCard h2').textContent,"
                " sel: document.getElementById('langSelect').value})"
            )
            check(
                "i18n: デフォルトは英語UI (lang=en / Connected / Add / Status)",
                ui_en.get("lang") == "en"
                and ui_en.get("status") == "Connected"
                and ui_en.get("add") == "Add"
                and ui_en.get("head") == "Status"
                and ui_en.get("sel") == "en",
                f"ui={ui_en}",
            )

            rebuilds_before_lang = page.evaluate(
                "window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'rebuildPageContainer').length"
            )
            page.select_option("#langSelect", "ja")
            page.wait_for_function(
                "() => document.getElementById('formSubmit').textContent === '追加'",
                timeout=5000,
            )
            # 言語切替でレンズがフル再描画 (rebuild 経路) される
            page.wait_for_function(
                "n => window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'rebuildPageContainer').length > n",
                arg=rebuilds_before_lang,
                timeout=5000,
            )
            ui_ja = page.evaluate(
                "({lang: document.documentElement.lang,"
                " status: document.getElementById('bridgeStatus').textContent,"
                " head: document.querySelector('#statusCard h2').textContent,"
                " footer: JSON.parse(window.__bridgeCalls.filter("
                "   c => JSON.parse(c.payload).method === 'rebuildPageContainer').pop().payload)"
                "   .data.textObject.find(o => o.containerName === 'footer').content,"
                " saved: localStorage.getItem('even_loader_lang_v1')})"
            )
            check(
                "i18n: 日本語切替でUI日本語化 + 保存 + レンズ rebuild 再描画 (footer 日本語)",
                ui_ja.get("lang") == "ja"
                and ui_ja.get("status") == "接続済み"
                and ui_ja.get("head") == "ステータス"
                and "スクロール:選択" in str(ui_ja.get("footer"))
                and ui_ja.get("saved") == "ja",
                f"ui={ui_ja}",
            )
            # 以降のステップはデフォルト (英語) 前提に戻す
            page.select_option("#langSelect", "en")
            page.wait_for_function(
                "() => document.getElementById('formSubmit').textContent === 'Add'",
                timeout=5000,
            )

            # ── 2. 接続先を追加して「接続」──────────────────────────
            page.fill("#formName", "sample-app")
            page.fill("#formUrl", SAMPLE_URL)
            page.click("#formSubmit")
            page.click("li.server-item button.connect")
            page.wait_for_url(f"{SAMPLE_URL}/*", timeout=10000)
            with_param = any(
                f":{SAMPLE_PORT}" in u and "even_loader=1" in u for u in nav_urls
            )
            check(
                "遷移: sample-app へ ?even_loader=1 付きでナビゲート",
                with_param,
                f"nav={[u for u in nav_urls if f':{SAMPLE_PORT}' in u]}",
            )

            # ── 3. シム有効化 (evenAppBridgeReady 後に単例メソッドをラップ) ──
            page.wait_for_function("() => window.__evenLoaderShim?.wrapped === true", timeout=5000)
            shim_state = page.evaluate(
                "({...window.__evenLoaderShim,"
                " flag: sessionStorage.getItem('even_loader_opened_from_loader'),"
                " url: location.href,"
                " ownWrap: Object.prototype.hasOwnProperty.call(window.EvenAppBridge, 'shutDownPageContainer')"
                "   && window.EvenAppBridge.shutDownPageContainer.__evenLoaderWrapped === true})"
            )
            check(
                "シム: EvenAppBridge.shutDownPageContainer をラップ + sessionStorage フラグ",
                shim_state.get("active") is True
                and shim_state.get("wrapped") is True
                and shim_state.get("ownWrap") is True
                and shim_state.get("flag") == "1",
                f"state={shim_state}",
            )
            check(
                "シム: URL から even_loader パラメータを除去 (replaceState)",
                "even_loader" not in shim_state.get("url", ""),
                f"url={shim_state.get('url')}",
            )

            # ── 4. sample-app の SDK がブリッジを使えている ─────────
            # ローダー経由 (viaLoader) のため、初回 createStartUpPageContainer は
            # シムが rebuildPageContainer に変換して送る (create はセッション1回きり)。
            page.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'rebuildPageContainer')",
                timeout=10000,
            )
            sample_methods = page.evaluate(
                "window.__bridgeCalls.map(c => JSON.parse(c.payload).method)"
            )
            rebuild_data = page.evaluate(
                "JSON.parse(window.__bridgeCalls.find(c => JSON.parse(c.payload).method === 'rebuildPageContainer').payload).data"
            )
            converted = page.evaluate("window.__evenLoaderShim.createConverted")
            check(
                "sample-app: 初回 create が rebuild に変換されて送信 (create は送られない)",
                "createStartUpPageContainer" not in sample_methods
                and converted == 1
                and rebuild_data.get("containerTotalNum") == 4,
                f"methods={sample_methods} converted={converted} containerTotalNum={rebuild_data.get('containerTotalNum')}",
            )

            # ── 5. exitMode 0/1 以外は透過委譲 (横取りしない) ─────────
            passthrough = page.evaluate(
                """async () => {
                  const before = window.__bridgeCalls.length;
                  const r = await window.EvenAppBridge.shutDownPageContainer(2);
                  const sent = window.__bridgeCalls.slice(before)
                    .map(c => JSON.parse(c.payload))
                    .filter(m => m.method === 'shutDownPageContainer');
                  return { result: r, sent, intercepted: window.__evenLoaderShim.intercepted };
                }"""
            )
            still_on_sample = page.url.startswith(SAMPLE_URL)
            check(
                "シム: shutDownPageContainer(2) は横取りせず App 側へ透過委譲",
                len(passthrough["sent"]) == 1
                and passthrough["sent"][0]["data"].get("exitMode") == 2
                and passthrough["intercepted"] == 0
                and still_on_sample,
                f"passthrough={passthrough} url={page.url}",
            )

            # ── 6. ダブルタップを SDK の受信口から注入 ──────────────
            page.evaluate(
                "msg => window._listenEvenAppMessage(msg)", DOUBLE_CLICK_MSG
            )
            page.wait_for_url(f"{LOADER_URL}/*", timeout=10000)
            check(
                "ダブルタップ: history.back() でローダー (:5178) へ復帰",
                page.url.startswith(LOADER_URL),
                f"url={page.url}",
            )

            # ── 7. 横取りの証拠 (console 記録はページ遷移後も残る) ──
            intercepted = any("shutDownPageContainer(1) を横取り" in l for l in console_lines)
            check("シム: shutDownPageContainer(1) の横取りログあり", intercepted)

            leaked = [
                l for l in console_lines
                if l.startswith("__FAKE_BRIDGE__")
                and "shutDownPageContainer" in l
                and '"exitMode":1' in l
            ]
            check(
                "偽ブリッジ: exitMode=1 の終了要求が App 側へ漏れていない",
                len(leaked) == 0,
                f"leaked={leaked}",
            )

            double_click_seen = any("DOUBLE_CLICK" in l for l in console_lines)
            check(
                "sample-app: DOUBLE_CLICK イベントが通常経路で処理された",
                double_click_seen,
            )

            # ── 8. 復帰後のローダーが再び動作している ────────────────
            # Playwright chromium は bfcache 無効のため通常は boot() 再実行になる。
            # bfcache 復元だった場合は pageshow ハンドラのログを確認する。
            # 復帰フラグにより、初回描画は create ではなく rebuildPageContainer になる
            # (ホスト側セッションには遷移先プラグインのコンテナが残っているため)。
            page.wait_for_selector("#bridgeStatus:has-text('Connected')", timeout=10000)
            page.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'rebuildPageContainer')",
                timeout=10000,
            )
            post_methods = page.evaluate(
                "window.__bridgeCalls.map(c => JSON.parse(c.payload).method)"
            )
            return_detected = any("プラグインからの復帰を検出" in l for l in console_lines)
            restored_via = (
                "pageshow(bfcache)"
                if any("pageshow (bfcache復元)" in l for l in console_lines)
                else "full reload (boot)"
            )
            check(
                "復帰後: ローダーの初回描画が rebuildPageContainer (create は呼ばれない)",
                "createStartUpPageContainer" not in post_methods and return_detected,
                f"calls={post_methods} 復帰検出={return_detected} 経路={restored_via}",
            )

            # ── 9. 復帰後の 800ms ガード再描画 (実機の初回フレーム取りこぼし対策) ──
            # 間に他の描画が無いため、rebuild がもう一度送られるはず。
            # rebuild/create の戻り値ログも出ていること。
            page.wait_for_function(
                "() => window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'rebuildPageContainer').length >= 2",
                timeout=10000,
            )
            guard_sent = any("rebuild を再送" in l for l in console_lines)
            result_logged = any("復帰 rebuild 送信 結果=" in l for l in console_lines)
            no_fallback = not any("フォールバック" in l for l in console_lines)
            check(
                "復帰後: 800ms ガード再描画が再送され、rebuild 戻り値がログされる",
                guard_sent and result_logged and no_fallback,
                f"再送={guard_sent} 結果ログ={result_logged} フォールバックなし={no_fallback}",
            )

            # ── 10. exitMode=0 (即時終了) も横取りされてローダーへ戻る ──
            page.goto(f"{SAMPLE_URL}/?even_loader=1")
            page.wait_for_function(
                "() => window.__evenLoaderShim && window.__evenLoaderShim.wrapped",
                timeout=10000,
            )
            page.evaluate("window.EvenAppBridge.shutDownPageContainer(0)")
            page.wait_for_url(f"{LOADER_URL}/*", timeout=10000)
            mode0_intercepted = any(
                "shutDownPageContainer(0) を横取り" in l for l in console_lines
            )
            check(
                "シム: shutDownPageContainer(0) (即時終了) も横取りしてローダーへ復帰",
                page.url.startswith(LOADER_URL) and mode0_intercepted,
                f"url={page.url} 横取りログ={mode0_intercepted}",
            )

            # ── 11. Connecting 中のダブルタップで接続中止 → 一覧へ復帰 ──
            # 応答しない接続先を登録して接続 → Connecting のまま保留になったところで
            # DOUBLE_CLICK → window.stop() で遷移中止 + rebuild で一覧再描画。
            # 注意: 遷移保留中の Playwright evaluate はタイムアウト無しで
            # ブロックし得るため、DOUBLE_CLICK はページ内タイマーで事前に仕込み、
            # 中止完了 (console ログ) を Python 側でポーリングしてから evaluate に戻る。
            page.wait_for_selector("#bridgeStatus:has-text('Connected')", timeout=10000)
            page.fill("#formName", "dead")
            page.fill("#formUrl", dead_url)
            page.click("#formSubmit")
            rebuilds_before = page.evaluate(
                "window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'rebuildPageContainer').length"
            )
            # 接続クリックの 1100ms 後 (assign から ~700ms 後) にダブルタップを発火。
            # 中止完了は console ログで待つ (expect_console_message はイベントループを
            # 回すので、遷移保留中でもページに触らずに待てる)
            page.evaluate(
                "msg => { setTimeout(() => window._listenEvenAppMessage(msg), 1100) }",
                DOUBLE_CLICK_MSG,
            )
            cancelled_log = True
            try:
                with page.expect_console_message(
                    lambda m: "接続を中止しました" in m.text, timeout=15000
                ):
                    page.click("li.server-item:nth-child(2) button.connect")
            except Exception:
                cancelled_log = False
            # 中止後は遷移が止まっているので evaluate 系が安全に使える
            page.wait_for_function(
                "n => window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'rebuildPageContainer').length > n",
                arg=rebuilds_before,
                timeout=10000,
            )
            still_loader = page.url.startswith(LOADER_URL)
            check(
                "Connecting中のダブルタップ: 遷移を中止し rebuild で一覧レンズを再描画",
                cancelled_log and still_loader,
                f"中止ログ={cancelled_log} url={page.url}",
            )

            # connecting 解除の確認: 直後の通常ダブルタップは従来どおり
            # shutDownPageContainer(1) が App 側へ送られる (ローダーにシムは無い)
            sd_before = page.evaluate(
                "window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'shutDownPageContainer').length"
            )
            page.evaluate("msg => window._listenEvenAppMessage(msg)", DOUBLE_CLICK_MSG)
            page.wait_for_function(
                "n => window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'shutDownPageContainer').length > n",
                arg=sd_before,
                timeout=5000,
            )
            last_sd = page.evaluate(
                "JSON.parse(window.__bridgeCalls.filter(c => JSON.parse(c.payload).method === 'shutDownPageContainer').pop().payload).data"
            )
            check(
                "中止後: connecting 解除済みで通常ダブルタップは shutDownPageContainer(1)",
                last_sd.get("exitMode") == 1 and page.url.startswith(LOADER_URL),
                f"data={last_sd} url={page.url}",
            )

            browser.close()
    finally:
        try:
            blackhole.close()
        except OSError:
            pass
        for p in procs:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    p.kill()

    print()
    failed = [r for r in results if not r[1]]
    print(f"結果: {len(results) - len(failed)}/{len(results)} PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
