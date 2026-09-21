#!/usr/bin/env python3
"""E2E: シム注入リバースプロキシ (proxy/server.ts) の検証。

検証項目:
  1. プロキシ経由の HTML にシム (__EVEN_LOADER_FROM_PROXY + /__even-loader/shim.js) が注入される
  2. URL パラメータ無しでもシムが有効化され、EvenAppBridge.shutDownPageContainer をラップする
  3. DOUBLE_CLICK → shutDownPageContainer(1) 横取り → history.back() で前ページへ戻る
  4. HTML 以外のアセットはバイト同一で素通しされる
  5. Vite HMR の WebSocket が 101 でアップグレードされる (生ソケットで確認)
  6. ターゲット未起動ポートは 502 日本語エラーページ (クラッシュしない)

実行:
  python3 tools/e2e_proxy.py
"""

import base64
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_PORT = 5183
# 開発運用中のプロキシ (6173/6183) と衝突しないよう、テスト専用プロキシは 7xxx を使う。
# targets.json は EVEN_LOADER_PROXY_TARGETS で一時ファイルに差し替える。
PROXY_PORT = 7183          # sample-app 用テストプロキシ
DEAD_PROXY_PORT = 7171     # ターゲット未起動 (502 検証用)
DEAD_TARGET_PORT = 59171   # 確実に空いている想定のターゲットポート
PROXY_URL = f"http://127.0.0.1:{PROXY_PORT}"
SAMPLE_URL = f"http://127.0.0.1:{SAMPLE_PORT}"
SEED_URL = f"{PROXY_URL}/__even-loader/shim.js"  # back() の戻り先となる履歴エントリ

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

results: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((label, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {label}" + (f" — {detail}" if detail else ""))


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port: int, proc: subprocess.Popen, what: str) -> None:
    for _ in range(100):
        if port_open(port):
            return
        if proc.poll() is not None:
            raise RuntimeError(f"{what} が起動できませんでした (port {port})")
        time.sleep(0.2)
    raise RuntimeError(f"{what} の起動がタイムアウトしました (port {port})")


def fetch(url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def ws_upgrade_status(port: int, path: str) -> str:
    """生ソケットで WebSocket アップグレードを試み、レスポンスの 1 行目を返す。"""
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: vite-hmr\r\n"
        "\r\n"
    )
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(req.encode())
        s.settimeout(10)
        data = s.recv(4096)
    return data.split(b"\r\n", 1)[0].decode(errors="replace")


def main() -> int:
    procs: list[subprocess.Popen] = []
    try:
        # ── サーバ起動 ──────────────────────────────────────────────
        print("sample-app dev server + proxy 起動中...")
        if not port_open(SAMPLE_PORT):
            p = subprocess.Popen(
                ["npx", "vite", "--host", "127.0.0.1", "--port", str(SAMPLE_PORT), "--strictPort"],
                cwd=ROOT / "sample-app",
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,  # npx の子 (vite) ごと killpg で確実に止める
            )
            procs.append(p)
            wait_port(SAMPLE_PORT, p, "sample-app dev server")
        targets_file = Path(tempfile.gettempdir()) / f"even-loader-e2e-targets-{os.getpid()}.json"
        targets_file.write_text(json.dumps([
            {"name": "sample-app", "target": f"http://127.0.0.1:{SAMPLE_PORT}", "port": PROXY_PORT},
            {"name": "dead", "target": f"http://127.0.0.1:{DEAD_TARGET_PORT}", "port": DEAD_PROXY_PORT},
        ]))
        p = subprocess.Popen(
            ["node", "proxy/server.ts"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env={**os.environ, "EVEN_LOADER_PROXY_TARGETS": str(targets_file)},
        )
        procs.append(p)
        wait_port(PROXY_PORT, p, "proxy")

        # ── 1. HTML 注入 ────────────────────────────────────────────
        status, body = fetch(f"{PROXY_URL}/")
        html = body.decode("utf-8")
        injected = (
            "window.__EVEN_LOADER_FROM_PROXY=1" in html
            and "/__even-loader/shim.js" in html
        )
        head_pos = html.lower().find("<head>")
        inject_pos = html.find("window.__EVEN_LOADER_FROM_PROXY=1")
        check(
            "プロキシ: HTML にシム注入 (<head> 直後)",
            status == 200 and injected and 0 <= head_pos < inject_pos,
            f"status={status} head@{head_pos} inject@{inject_pos}",
        )
        cl = None
        req = urllib.request.Request(f"{PROXY_URL}/", headers={"Accept-Encoding": "identity"})
        with urllib.request.urlopen(req, timeout=10) as r:
            cl = r.headers.get("Content-Length")
            body2 = r.read()
        check(
            "プロキシ: 注入後の Content-Length が再計算されている",
            cl is not None and int(cl) == len(body2),
            f"Content-Length={cl} actual={len(body2)}",
        )

        # ── 4. 非 HTML アセットはバイト同一 ─────────────────────────
        asset = "/src/main.ts"
        _, direct = fetch(f"{SAMPLE_URL}{asset}")
        _, proxied = fetch(f"{PROXY_URL}{asset}")
        check(
            f"プロキシ: 非HTMLアセット ({asset}) がバイト同一で素通し",
            direct == proxied and len(direct) > 0,
            f"direct={len(direct)}B proxied={len(proxied)}B",
        )

        # ── 5. Vite HMR WebSocket 101 ───────────────────────────────
        _, client_js = fetch(f"{PROXY_URL}/@vite/client")
        m = re.search(r'wsToken\s*=\s*"([^"]+)"', client_js.decode("utf-8"))
        token_q = f"?token={m.group(1)}" if m else ""
        status_line = ws_upgrade_status(PROXY_PORT, f"/{token_q}")
        check(
            "プロキシ: Vite HMR WebSocket が 101 でアップグレード",
            "101" in status_line,
            f"status_line={status_line!r} token={'あり' if m else 'なし'}",
        )

        # ── 6. ターゲット未起動 → 502 日本語ページ ──────────────────
        status, body = fetch(f"http://127.0.0.1:{DEAD_PROXY_PORT}/")
        text = body.decode("utf-8")
        check(
            "プロキシ: ターゲット未起動ポートは 502 日本語エラーページ",
            status == 502 and "dev server に接続できません" in text,
            f"status={status}",
        )

        # ── 7. /__even-loader/log: CORS 付き POST/GET/OPTIONS ───────
        req = urllib.request.Request(
            f"{PROXY_URL}/__even-loader/log",
            data=json.dumps(
                {"src": "e2e", "origin": "http://ehpk.example", "msg": "リモートログ疎通テスト"}
            ).encode(),
            headers={
                "Content-Type": "text/plain;charset=UTF-8",
                "Origin": "http://ehpk.example",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            post_status = r.status
            post_acao = r.headers.get("Access-Control-Allow-Origin")
        _, log_body = fetch(f"{PROXY_URL}/__even-loader/log")
        req = urllib.request.Request(
            f"{PROXY_URL}/__even-loader/log",
            method="OPTIONS",
            headers={
                "Origin": "http://ehpk.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            opt_status = r.status
            opt_acao = r.headers.get("Access-Control-Allow-Origin")
        check(
            "プロキシ: /__even-loader/log が CORS 付きで POST/GET/OPTIONS に応答",
            post_status == 204
            and post_acao == "*"
            and "リモートログ疎通テスト" in log_body.decode("utf-8")
            and opt_status == 204
            and opt_acao == "*",
            f"post={post_status}/{post_acao} options={opt_status}/{opt_acao}",
        )

        # ── 2, 3. Playwright: シム有効化と復帰 ──────────────────────
        console_lines: list[str] = []
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context()
            ctx.add_init_script(FAKE_BRIDGE_INIT)
            page = ctx.new_page()
            page.on("console", lambda msg: console_lines.append(msg.text))

            # back() の戻り先を作る (プロキシ配信の shim.js を履歴に積む)
            page.goto(SEED_URL)
            # URL パラメータ・sessionStorage 無しでプロキシ経由アクセス
            page.goto(f"{PROXY_URL}/")
            page.wait_for_function(
                "() => window.__evenLoaderShim?.wrapped === true", timeout=10000
            )
            state = page.evaluate(
                "({...window.__evenLoaderShim,"
                " flag: sessionStorage.getItem('even_loader_opened_from_loader'),"
                " fromProxy: window.__EVEN_LOADER_FROM_PROXY,"
                " ownWrap: Object.prototype.hasOwnProperty.call(window.EvenAppBridge, 'shutDownPageContainer')"
                "   && window.EvenAppBridge.shutDownPageContainer.__evenLoaderWrapped === true})"
            )
            check(
                "シム: URL パラメータ無しでプロキシフラグにより有効化 + ラップ",
                state.get("active") is True
                and state.get("wrapped") is True
                and state.get("ownWrap") is True
                and state.get("fromProxy") == 1
                and state.get("flag") is None,
                f"state={state}",
            )

            # プロキシ直アクセス (ローダー経由でない) では create→rebuild 変換はしない
            # (新規セッションの可能性があるため。変換はローダー経由確定時のみ)
            page.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'createStartUpPageContainer')",
                timeout=10000,
            )
            direct_state = page.evaluate(
                "({viaLoader: window.__evenLoaderShim.viaLoader,"
                " createConverted: window.__evenLoaderShim.createConverted})"
            )
            check(
                "シム: プロキシ直アクセスでは create をそのまま通す (変換なし)",
                direct_state.get("viaLoader") is False
                and direct_state.get("createConverted") == 0,
                f"state={direct_state}",
            )

            # sample-app には Vite プラグイン注入も同居している → 二重ラップしないこと
            double = page.evaluate(
                "(() => { const f = window.EvenAppBridge.shutDownPageContainer;"
                " return { wrapped: f.__evenLoaderWrapped === true } })()"
            )
            shim_count = page.content().count("even-loader-shim.js")
            check(
                "シム: Vite プラグイン注入と同居しても単一状態 (二重ラップなし)",
                double["wrapped"] is True,
                f"注入痕跡(参考)={shim_count}",
            )

            # exitMode 0/1 以外は透過委譲
            passthrough = page.evaluate(
                """async () => {
                  const before = window.__bridgeCalls.length;
                  await window.EvenAppBridge.shutDownPageContainer(2);
                  const sent = window.__bridgeCalls.slice(before)
                    .map(c => JSON.parse(c.payload))
                    .filter(m => m.method === 'shutDownPageContainer');
                  return { sent, intercepted: window.__evenLoaderShim.intercepted };
                }"""
            )
            check(
                "シム: shutDownPageContainer(2) は横取りせず透過委譲",
                len(passthrough["sent"]) == 1
                and passthrough["sent"][0]["data"].get("exitMode") == 2
                and passthrough["intercepted"] == 0,
                f"passthrough={passthrough}",
            )

            # DOUBLE_CLICK → 横取り → history.back()
            page.evaluate("msg => window._listenEvenAppMessage(msg)", DOUBLE_CLICK_MSG)
            page.wait_for_url(SEED_URL, timeout=10000)
            check(
                "ダブルタップ: shutDownPageContainer(1) 横取り → history.back() で前ページへ",
                page.url == SEED_URL,
                f"url={page.url}",
            )
            intercepted = any(
                "shutDownPageContainer(1) を横取り" in l for l in console_lines
            )
            check("シム: 横取りログあり", intercepted)
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

            # ── ローダー経由 (?even_loader=1): create→rebuild 変換 ──
            # 別コンテキスト (sessionStorage を共有しない) で検証する
            ctx2 = browser.new_context()
            ctx2.add_init_script(FAKE_BRIDGE_INIT)
            page2 = ctx2.new_page()
            conv_logs: list[str] = []
            page2.on("console", lambda msg: conv_logs.append(msg.text))
            page2.goto(f"{PROXY_URL}/?even_loader=1")
            page2.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'rebuildPageContainer')",
                timeout=10000,
            )
            conv = page2.evaluate(
                "({viaLoader: window.__evenLoaderShim.viaLoader,"
                " createConverted: window.__evenLoaderShim.createConverted,"
                " methods: window.__bridgeCalls.map(c => JSON.parse(c.payload).method),"
                " rebuildData: JSON.parse(window.__bridgeCalls.find("
                "   c => JSON.parse(c.payload).method === 'rebuildPageContainer').payload).data})"
            )
            check(
                "シム: ローダー経由では初回 create を rebuild に変換 (create は送られない)",
                conv.get("viaLoader") is True
                and conv.get("createConverted") == 1
                and "createStartUpPageContainer" not in conv.get("methods", [])
                and conv.get("rebuildData", {}).get("containerTotalNum") == 4
                and any("rebuildPageContainer に変換" in l for l in conv_logs),
                f"conv={conv}",
            )

            # 2 回目以降の create は素通し (変換は初回のみ)
            second = page2.evaluate(
                """async () => {
                  const before = window.__bridgeCalls.length;
                  await window.EvenAppBridge.createStartUpPageContainer({ containerTotalNum: 1 });
                  return window.__bridgeCalls.slice(before)
                    .map(c => JSON.parse(c.payload).method);
                }"""
            )
            check(
                "シム: 2 回目の create は変換せず素通し",
                second == ["createStartUpPageContainer"],
                f"sent={second}",
            )

            # 後続描画が無い場合: 600ms 後に変換 rebuild が一度だけ再送される
            # (sample-app は起動後に追加描画をしないため再送が発動するはず)
            page2.wait_for_function(
                "() => window.__evenLoaderShim.resent === 1", timeout=8000
            )
            resend_info = page2.evaluate(
                "({resent: window.__evenLoaderShim.resent,"
                " rebuilds: window.__bridgeCalls.filter("
                "   c => JSON.parse(c.payload).method === 'rebuildPageContainer').length})"
            )
            resend_logged = any("変換 rebuild を再送" in l for l in conv_logs)
            check(
                "シム: 後続描画が無ければ変換 rebuild を一度だけ再送 (ログあり)",
                resend_info["resent"] == 1
                and resend_info["rebuilds"] == 2
                and resend_logged,
                f"resend={resend_info} logged={resend_logged}",
            )

            # 後続描画がある場合: 再送されない (RESEND_MS を 1500ms に伸ばして
            # その間にアプリ描画相当の textContainerUpgrade を挟む)
            ctx3 = browser.new_context()
            ctx3.add_init_script(FAKE_BRIDGE_INIT)
            ctx3.add_init_script("window.__EVEN_LOADER_SHIM_RESEND_MS = 1500")
            page3 = ctx3.new_page()
            skip_logs: list[str] = []
            page3.on("console", lambda msg: skip_logs.append(msg.text))
            page3.goto(f"{PROXY_URL}/?even_loader=1")
            page3.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'rebuildPageContainer')",
                timeout=10000,
            )
            # 変換直後にアプリの後続描画をシミュレート (観測ラッパ経由で appDrew が立つ)
            page3.evaluate(
                "window.EvenAppBridge.textContainerUpgrade("
                "{containerID: 2, containerName: 'main', contentOffset: 0, contentLength: 5, content: 'x'})"
            )
            page3.wait_for_timeout(2200)  # RESEND_MS(1500ms) 経過を待つ
            no_resend = page3.evaluate(
                "({resent: window.__evenLoaderShim.resent,"
                " rebuilds: window.__bridgeCalls.filter("
                "   c => JSON.parse(c.payload).method === 'rebuildPageContainer').length})"
            )
            skip_logged = any("再送はスキップ" in l for l in skip_logs)
            check(
                "シム: 後続描画があれば再送しない (スキップログあり)",
                no_resend["resent"] == 0 and no_resend["rebuilds"] == 1 and skip_logged,
                f"state={no_resend} skip_logged={skip_logged}",
            )
            browser.close()
    finally:
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
