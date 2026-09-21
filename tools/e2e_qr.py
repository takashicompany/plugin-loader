#!/usr/bin/env python3
"""E2E: 「QRで追加」の戦略B (file input フォールバック) の検証。

検証すること:
  1. ブリッジ無し + カメラ無し (headless chromium) では、「QRで追加」ボタンが
     getUserMedia 失敗を検出して file chooser (input[capture]) へフォールバックする
  2. QR画像 (ペイロード = dev server URL) を渡すと jsqr でデコードされ、
     追加フォームの URL/名前がプリフィルされる
  3. QRを含まない画像では日本語のエラーメッセージが表示される

QR画像はテスト内で生成する (loader の devDependency `qrcode` を node -e で使用)。

実行:
  python3 tools/e2e_qr.py
"""

import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
LOADER_DIR = ROOT / "loader"
TEST_URL = "http://192.168.1.10:5183/"
EXPECTED_NAME = "192.168.1.10:5183"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_images(outdir: Path) -> tuple[Path, Path]:
    """QR PNG と 非QR PNG (単色) を loader の node 依存で生成する"""
    qr_png = outdir / "qr.png"
    blank_png = outdir / "blank.png"
    script = f"""
const qrcode = require('qrcode');
const {{ PNG }} = require('pngjs');
const fs = require('fs');
qrcode.toFile({str(qr_png)!r}, {TEST_URL!r}, {{ width: 512, margin: 4 }}, (err) => {{
  if (err) {{ console.error(err); process.exit(1); }}
  const png = new PNG({{ width: 200, height: 200 }});
  for (let i = 0; i < png.data.length; i += 4) {{
    png.data[i] = 128; png.data[i+1] = 128; png.data[i+2] = 128; png.data[i+3] = 255;
  }}
  fs.writeFileSync({str(blank_png)!r}, PNG.sync.write(png));
  console.log('images ok');
}});
"""
    subprocess.run(
        ["node", "-e", script],
        cwd=LOADER_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    assert qr_png.exists() and blank_png.exists()
    return qr_png, blank_png


def wait_port(port: int, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise RuntimeError(f"port {port} が開かない")


def main() -> int:
    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        status = "PASS" if cond else "FAIL"
        print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))
        if not cond:
            failures.append(name)

    tmpdir = Path(tempfile.mkdtemp(prefix="e2e-qr-"))
    print(f"1. テスト画像を生成 ({tmpdir})")
    qr_png, blank_png = make_images(tmpdir)

    port = free_port()
    print(f"2. loader dev server を起動 (port {port})")
    vite = subprocess.Popen(
        ["npx", "vite", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=LOADER_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_port(port)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/", wait_until="domcontentloaded")
            page.wait_for_selector("#qrAddBtn")

            # ── B経路: QR画像 → プリフィル ─────────────────────────
            print("3. 「QRで追加」→ file chooser フォールバック → QR画像")
            with page.expect_file_chooser(timeout=10000) as fc_info:
                page.click("#qrAddBtn")
            fc = fc_info.value
            check(
                "getUserMedia失敗時にfile chooserへフォールバック",
                fc is not None,
            )
            fc.set_files(str(qr_png))

            page.wait_for_function(
                "() => document.getElementById('formUrl').value !== ''",
                timeout=10000,
            )
            url_val = page.input_value("#formUrl")
            name_val = page.input_value("#formName")
            check("URLがプリフィルされる", url_val == TEST_URL, f"formUrl={url_val!r}")
            check(
                "名前がhostname:portで提案される",
                name_val == EXPECTED_NAME,
                f"formName={name_val!r}",
            )
            check(
                "エラー表示なし",
                page.is_hidden("#qrError"),
            )
            log_text = page.text_content("#log") or ""
            check("ログにQR読み取り成功が出る", "QR読み取り成功" in log_text)

            # ── B経路: 非QR画像 → エラー ──────────────────────────
            print("4. 「QRで追加」→ 非QR画像 → エラーメッセージ")
            with page.expect_file_chooser(timeout=10000) as fc_info2:
                page.click("#qrAddBtn")
            fc_info2.value.set_files(str(blank_png))

            page.wait_for_selector("#qrError:not([hidden])", timeout=10000)
            err_text = page.text_content("#qrError") or ""
            check(
                "非QR画像で日本語エラー",
                "QRコードを読み取れませんでした" in err_text,
                f"qrError={err_text!r}",
            )
            # プリフィル済みのURLは壊されない
            check(
                "エラー時に既存プリフィルを破壊しない",
                page.input_value("#formUrl") == TEST_URL,
            )

            # ── プリフィル → 追加 で一覧に載る ─────────────────────
            print("5. 「追加」で接続先一覧に登録される")
            page.click("#formSubmit")
            page.wait_for_selector(f".server-item .server-url:text('{TEST_URL}')", timeout=5000)
            check(
                "一覧に追加される",
                TEST_URL in (page.text_content("#serverList") or ""),
            )

            browser.close()
    finally:
        vite.terminate()
        try:
            vite.wait(timeout=5)
        except subprocess.TimeoutExpired:
            vite.kill()

    print()
    if failures:
        print(f"NG: {len(failures)} 件失敗: {failures}")
        return 1
    print("OK: 全チェック PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
