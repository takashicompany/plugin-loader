#!/usr/bin/env python3
"""E2E: 実プロダクト external-app (無改変) をシム注入プロキシ経由で動かす検証。

external-app (EXTERNAL_APP_DIR で指定) は READ-ONLY。dev server を起動するだけで
リポジトリには一切手を入れない。

Phase A (HTTP + Playwright/偽ブリッジ):
  - プロキシ経由 HTML に external-app 本来のスクリプトが残ったままシムが注入される
  - external-app の allowedHosts は ['.ts.net'] のみ → 直接だと不明ホストは 403、
    プロキシは Host を書き換えるので通る (changeOrigin の実証)
  - DOUBLE_CLICK → external-app 自身の handleDoubleClick → shutDownPageContainer(1)
    → シムが横取り → history.back()

Phase B (公式シミュレータ evenhub-simulator 0.7.3 / xvfb):
  - loader → (click) → external-app をプロキシ URL 経由で開く → (double_click) →
    シム横取りで loader へ復帰。console ログとスクリーンショットで確認。

実行:
  python3 tools/e2e_external_app_proxy.py
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXTERNAL_APP = Path(os.environ.get("EXTERNAL_APP_DIR", ROOT.parent / "external-app"))
EXTERNAL_APP_MARKER = os.environ.get("EXTERNAL_APP_MARKER", "")
SIMULATOR = Path(os.environ.get(
    "EVEN_SIMULATOR_PATH",
    ROOT / "node_modules/@evenrealities/evenhub-simulator/bin/index.js",
))
OUT_DIR = Path(os.environ.get("E2E_OUT_DIR", ROOT / "tools" / "e2e-out"))

EXTERNAL_APP_PORT = 5173
# 開発運用中のプロキシ (6173/6183) と衝突しないよう、テスト専用プロキシは 7173 を使う。
# external-app dev (5173) / loader dev (5178) は稼働中ならそのまま再利用する。
PROXY_PORT = 7173
LOADER_PORT = 5178
AUTOMATION_PORT = 9899
PROXY_URL = f"http://127.0.0.1:{PROXY_PORT}"
SEED_URL = f"{PROXY_URL}/__even-loader/shim.js"

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


def wait_port(port: int, proc: subprocess.Popen | None, what: str, tries: int = 150) -> None:
    for _ in range(tries):
        if port_open(port):
            return
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"{what} が起動できませんでした (port {port})")
        time.sleep(0.2)
    raise RuntimeError(f"{what} の起動がタイムアウトしました (port {port})")


def fetch(url: str, host_header: str | None = None) -> tuple[int, bytes]:
    headers = {"Accept-Encoding": "identity"}
    req = urllib.request.Request(url, headers=headers)
    if host_header:
        # urllib は Host を headers 経由で上書きできる
        req.add_unredirected_header("Host", host_header)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def api(path: str, payload: dict | None = None) -> bytes:
    url = f"http://127.0.0.1:{AUTOMATION_PORT}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def console_text() -> str:
    try:
        return api("/api/console").decode("utf-8", errors="replace")
    except Exception as e:
        return f"<console取得失敗: {e}>"


def wait_console(substr: str, timeout_s: float = 20, count: int = 1) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if console_text().count(substr) >= count:
            return True
        time.sleep(0.5)
    return False


def screenshot(kind: str, name: str) -> None:
    try:
        data = api(f"/api/screenshot/{kind}")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / name).write_bytes(data)
        print(f"  screenshot: {OUT_DIR / name} ({len(data)}B)")
    except Exception as e:
        print(f"  screenshot {kind} 失敗: {e}")


def main() -> int:
    procs: list[subprocess.Popen] = []
    sim: subprocess.Popen | None = None
    try:
        # ── サーバ起動 (external-app は起動のみ・無改変) ─────────────────
        print("external-app dev server + proxy + loader 起動中...")
        for cwd, port, what in (
            (EXTERNAL_APP, EXTERNAL_APP_PORT, "external-app dev server"),
            (ROOT / "loader", LOADER_PORT, "loader dev server"),
        ):
            if not port_open(port):
                p = subprocess.Popen(
                    ["npx", "vite", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
                    cwd=cwd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,  # npx の子 (vite) ごと killpg で確実に止める
                )
                procs.append(p)
                wait_port(port, p, what)
        import tempfile
        targets_file = Path(tempfile.gettempdir()) / f"even-loader-e2e-gs-targets-{os.getpid()}.json"
        targets_file.write_text(json.dumps([
            {"name": "external-app", "target": f"http://127.0.0.1:{EXTERNAL_APP_PORT}", "port": PROXY_PORT},
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

        # ── Phase A-1: HTML 注入 + external-app スクリプト無傷 ───────────
        status, body = fetch(f"{PROXY_URL}/")
        html = body.decode("utf-8")
        check(
            "external-app: プロキシ経由 HTML にシム注入 + 本来のスクリプト無傷",
            status == 200
            and "window.__EVEN_LOADER_FROM_PROXY=1" in html
            and "/__even-loader/shim.js" in html
            and (EXTERNAL_APP_MARKER in html if EXTERNAL_APP_MARKER else True)
            and '/src/main.ts' in html,
            f"status={status} len={len(html)}",
        )

        # ── Phase A-2: allowedHosts と changeOrigin の実証 ──────────
        status_direct, _ = fetch(f"http://127.0.0.1:{EXTERNAL_APP_PORT}/", host_header="dev.example.com")
        status_proxy, _ = fetch(f"{PROXY_URL}/", host_header="dev.example.com")
        check(
            "external-app: 不明ホスト直アクセスは 403 / プロキシは Host 書き換えで 200",
            status_direct == 403 and status_proxy == 200,
            f"direct={status_direct} proxy={status_proxy}",
        )

        # ── Phase A-3: Playwright — external-app のダブルタップ復帰 ──────
        console_lines: list[str] = []
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context()
            ctx.add_init_script(FAKE_BRIDGE_INIT)
            page = ctx.new_page()
            page.on("console", lambda msg: console_lines.append(msg.text))

            page.goto(SEED_URL)                # back() の戻り先
            page.goto(f"{PROXY_URL}/")         # パラメータ無し
            page.wait_for_function(
                "() => window.__evenLoaderShim?.wrapped === true", timeout=15000
            )
            check("external-app: シムがブリッジをラップ (パラメータ無し・プロキシフラグ)", True)

            # external-app 自身が SDK 経由でレンズ描画に到達している
            # (プロキシ直アクセス = ローダー経由でないので create はそのまま通る)
            page.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'createStartUpPageContainer')",
                timeout=15000,
            )
            no_convert = page.evaluate("window.__evenLoaderShim.createConverted") == 0
            check(
                "external-app: 自身のコードが SDK 経由でレンズ描画呼び出しに到達 (直アクセスは変換なし)",
                no_convert,
            )

            # DOUBLE_CLICK → external-app の handleDoubleClick ('not-logged-in') → exitApp(1)
            page.evaluate("msg => window._listenEvenAppMessage(msg)", DOUBLE_CLICK_MSG)
            page.wait_for_url(SEED_URL, timeout=15000)
            intercepted = any(
                "shutDownPageContainer(1) を横取り" in l for l in console_lines
            )
            leaked = [
                l for l in console_lines
                if l.startswith("__FAKE_BRIDGE__")
                and "shutDownPageContainer" in l
                and '"exitMode":1' in l
            ]
            check(
                "external-app: ダブルタップ → shutDownPageContainer(1) 横取り → history.back()",
                page.url == SEED_URL and intercepted and not leaked,
                f"url={page.url} intercepted={intercepted} leaked={leaked}",
            )

            # ── Phase A-4: ローダー経由 (?even_loader=1) では create→rebuild 変換 ──
            ctx2 = browser.new_context()
            ctx2.add_init_script(FAKE_BRIDGE_INIT)
            page2 = ctx2.new_page()
            page2.goto(f"{PROXY_URL}/?even_loader=1")
            page2.wait_for_function(
                "() => window.__bridgeCalls.some(c => JSON.parse(c.payload).method === 'rebuildPageContainer')",
                timeout=15000,
            )
            conv = page2.evaluate(
                "({converted: window.__evenLoaderShim.createConverted,"
                " methods: window.__bridgeCalls.map(c => JSON.parse(c.payload).method)})"
            )
            check(
                "external-app: ローダー経由では初回 create が rebuild に変換 (create は送られない)",
                conv.get("converted") == 1
                and "createStartUpPageContainer" not in conv.get("methods", [])
                and "rebuildPageContainer" in conv.get("methods", []),
                f"conv={conv}",
            )
            browser.close()

        # ── Phase B: 公式シミュレータ (xvfb) ────────────────────────
        print("シミュレータ起動中 (xvfb-run)...")
        seed = (
            f"http://127.0.0.1:{LOADER_PORT}/e2e-seed.html"
            f"?name=external-app&url={PROXY_URL}"
        )
        sim = subprocess.Popen(
            [
                "xvfb-run", "-a", "node", str(SIMULATOR), seed,
                "--automation-port", str(AUTOMATION_PORT),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        wait_port(AUTOMATION_PORT, sim, "simulator automation API", tries=300)
        api("/api/ping")

        # ローダー起動 (レンズ初期描画) を待つ
        loader_ready = wait_console("レンズ初期描画 完了", 30)
        check("シミュレータ: ローダー起動・レンズ初期描画", loader_ready)
        screenshot("glasses", "sim1_loader_glasses.png")

        # click → external-app (プロキシ URL) へ接続
        api("/api/input", {"action": "click"})
        shim_active = wait_console("[even-loader-shim] 有効", 30)
        wrapped = wait_console("shutDownPageContainer をラップしました", 30)
        check(
            "シミュレータ: click で external-app (プロキシ経由) へ遷移 + シム有効化",
            shim_active and wrapped,
            f"active={shim_active} wrapped={wrapped}",
        )
        # ローダー経由 (?even_loader=1) なので external-app の初回 create は rebuild に変換される
        converted = wait_console("rebuildPageContainer に変換", 30)
        check("シミュレータ: external-app の初回 create が rebuild に変換 (変換後も正常表示)", converted)
        time.sleep(3)  # external-app のレンズ描画を待つ
        screenshot("glasses", "sim2_external_app_glasses.png")
        screenshot("webview", "sim2_external_app_webview.png")

        # double_click → シム横取り → history.back() → ローダー復帰
        api("/api/input", {"action": "double_click"})
        intercepted = wait_console("shutDownPageContainer(1) を横取り", 20)
        # 復帰の証拠: bfcache リロードログ、または boot ログの 2 回目 (接続先ロード)
        returned = wait_console("リロードしてローダーを再初期化", 20) or wait_console(
            "接続先を", 20, count=2
        )
        check(
            "シミュレータ: double_click 横取り → ローダー復帰",
            intercepted and returned,
            f"intercepted={intercepted} returned={returned}",
        )
        time.sleep(3)  # 復帰後のレンズ再描画を待つ
        screenshot("glasses", "sim3_back_to_loader_glasses.png")
        screenshot("webview", "sim3_back_to_loader_webview.png")

        # 復帰後にローダーのレンズ再描画が走ったか (boot 2 回目)
        redraw = wait_console("レンズ初期描画 完了", 20, count=2)
        check("シミュレータ: 復帰後ローダーがレンズ再描画 (2回目の初期描画)", redraw)

        # 復帰フラグが検出され、初回描画が rebuildPageContainer になったか
        # (create フォールバックのログが無いことも確認)
        return_detected = wait_console("プラグインからの復帰を検出", 10)
        fell_back = "createStartUpPageContainer にフォールバック" in console_text()
        check(
            "シミュレータ: 復帰後の初回描画が rebuildPageContainer (フォールバックなし)",
            return_detected and not fell_back,
            f"復帰検出={return_detected} フォールバック={fell_back}",
        )

        log = console_text()
        (OUT_DIR / "sim_console.log").write_text(log)
        print(f"  console log: {OUT_DIR / 'sim_console.log'} ({len(log)}B)")
    finally:
        if sim is not None:
            try:
                os.killpg(os.getpgid(sim.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                sim.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(sim.pid), signal.SIGKILL)
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
