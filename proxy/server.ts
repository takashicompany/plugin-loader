// even-loader shim 注入リバースプロキシ。
//
// 開発中プラグインの dev server (Vite 等) の手前に立ち、返ってくる HTML に
// even-loader-shim.js を注入する。プラグイン側のリポジトリには一切手を入れない
// (vite.config.ts の 1 行すら不要)。
//
// - 設定: proxy/targets.json — [{ name, target, port }] の配列。
//   規約: プロキシポート = ターゲットポート + 1000 (例 5173 → 6173)。
// - HTTP も WebSocket (Vite HMR) も透過転送。Host ヘッダはターゲットに
//   書き換える (changeOrigin 相当) ため、allowedHosts 未設定の dev server でも通る。
// - 注入は Content-Type: text/html のレスポンスのみ。<head> 直後に
//   <script>window.__EVEN_LOADER_FROM_PROXY=1</script>
//   <script src="/__even-loader/shim.js"></script> を差し込む。
//   圧縮展開を避けるため、転送リクエストから Accept-Encoding を落として
//   上流に非圧縮で返させ、注入後に Content-Length を再計算する。
// - /__even-loader/shim.js はプロキシ自身が配信する。実体は
//   loader/public/even-loader-shim.js をリクエスト毎に読む (single source of truth)。
// - ターゲットが落ちている場合はクラッシュせず 502 の日本語エラーページを返す。
//
// 起動: リポジトリルートで `npm run proxy` (実体は `node proxy/server.ts`)。

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { createProxyServer } from 'http-proxy-3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHIM_PATH = resolve(__dirname, '../loader/public/even-loader-shim.js')
// EVEN_LOADER_PROXY_TARGETS で設定ファイルを差し替えられる
// (E2E テストが稼働中のプロキシとポートを衝突させずに別インスタンスを立てるため)
const TARGETS_PATH = process.env.EVEN_LOADER_PROXY_TARGETS
  ? resolve(process.cwd(), process.env.EVEN_LOADER_PROXY_TARGETS)
  : resolve(__dirname, 'targets.json')

interface TargetEntry {
  name: string
  target: string
  port: number
}

// 実機ではWebViewのconsoleが見えないため、console/エラーをプロキシへ転送する
const CONSOLE_RELAY =
  '<script>(function(){var q=[],t=null;' +
  'function send(){if(!q.length)return;var b=JSON.stringify(q);q=[];' +
  "try{fetch('/__even-loader/log',{method:'POST',headers:{'Content-Type':'application/json'},body:b,keepalive:true}).catch(function(){})}catch(e){}}" +
  'function push(k,a){try{q.push({k:k,m:Array.prototype.map.call(a,function(x){try{return typeof x==="string"?x:JSON.stringify(x)}catch(e){return String(x)}}).join(" ")});' +
  'if(!t){t=setTimeout(function(){t=null;send()},500)}}catch(e){}}' +
  '["log","info","warn","error"].forEach(function(k){var o=console[k];console[k]=function(){push(k,arguments);o.apply(console,arguments)}});' +
  'window.addEventListener("error",function(e){push("onerror",[e.message+" @"+e.filename+":"+e.lineno])});' +
  'window.addEventListener("unhandledrejection",function(e){push("unhandledrejection",[String(e.reason)])});' +
  '})();</script>'

const INJECT_SNIPPET =
  '<script>window.__EVEN_LOADER_FROM_PROXY=1</script>' +
  CONSOLE_RELAY +
  '<script src="/__even-loader/shim.js"></script>'

// ─── 設定読み込み ──────────────────────────────────────────────────────
function loadTargets(): TargetEntry[] {
  const raw = JSON.parse(readFileSync(TARGETS_PATH, 'utf-8'))
  if (!Array.isArray(raw)) throw new Error('targets.json は配列である必要があります')
  for (const e of raw) {
    if (!e || typeof e.name !== 'string' || typeof e.target !== 'string' || typeof e.port !== 'number') {
      throw new Error(`targets.json のエントリが不正です: ${JSON.stringify(e)}`)
    }
  }
  return raw as TargetEntry[]
}

// ─── HTML 注入 ─────────────────────────────────────────────────────────
function injectIntoHtml(html: string): string {
  // <head> 直後に注入。無ければ <html> 直後、それも無ければ先頭に付ける。
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + INJECT_SNIPPET + html.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + INJECT_SNIPPET + html.slice(at)
  }
  return INJECT_SNIPPET + html
}

// ─── エラーページ (502) ────────────────────────────────────────────────
function send502(res: http.ServerResponse, entry: TargetEntry, err: Error): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>502 - even-loader proxy</title></head><body>' +
    `<h1>dev server に接続できません</h1>` +
    `<p>「${entry.name}」のターゲット <code>${entry.target}</code> が応答しません。</p>` +
    `<p>dev server が起動しているか確認してください (例: <code>npm run dev</code>)。</p>` +
    `<p><small>even-loader proxy (port ${entry.port}) / ${err.message}</small></p>` +
    '</body></html>'
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

// ─── リモートログ (/__even-loader/log) ──────────────────────────────────
// 受け口は 2 系統:
//   - CONSOLE_RELAY (プロキシ経由ページの console.*): JSON 配列 [{k, m}]
//   - ローダー .ehpk オリジンからの直接 POST: JSON 単体 {src, origin, msg} または生テキスト
// どちらも stdout とリングバッファに残す。GET で直近ログを閲覧できる:
//   curl http://127.0.0.1:6173/__even-loader/log
// ローダー本体 (.ehpk = クロスオリジン) からも POST できるよう CORS
// (Access-Control-Allow-Origin: *) と OPTIONS プリフライトに対応する。
const LOG_BUFFER_MAX = 2000
const remoteLogBuffer: string[] = []
function pushRemoteLog(line: string): void {
  remoteLogBuffer.push(line)
  if (remoteLogBuffer.length > LOG_BUFFER_MAX) {
    remoteLogBuffer.splice(0, remoteLogBuffer.length - LOG_BUFFER_MAX)
  }
  console.log(line)
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function handleLogBody(body: string, entryName: string): void {
  const stamp = new Date().toISOString().slice(11, 23)
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed)) {
      // CONSOLE_RELAY のバッチ形式 [{k, m}]
      for (const e of parsed) pushRemoteLog(`[console:${entryName} ${stamp}] ${e.k}: ${e.m}`)
      return
    }
    if (parsed && typeof parsed === 'object') {
      // ローダー等からの単体形式 {src, origin, msg}
      const p = parsed as Record<string, unknown>
      pushRemoteLog(`[${p.src ?? 'remote'}:${entryName} ${stamp}] ${p.origin ?? ''} ${p.msg ?? body}`)
      return
    }
    pushRemoteLog(`[remote:${entryName} ${stamp}] ${body}`)
  } catch {
    pushRemoteLog(`[remote:${entryName} ${stamp}] ${body}`)
  }
}

// ─── /__even-loader/* (プロキシ自身が配信) ──────────────────────────────
function serveOwn(req: http.IncomingMessage, res: http.ServerResponse, entryName: string): void {
  const path = (req.url ?? '').split('?')[0]
  if (req.method === 'OPTIONS') {
    // CORS プリフライト (ローダー .ehpk オリジンからの POST 用)
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (path === '/__even-loader/log' && req.method === 'POST') {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= 256 * 1024) chunks.push(c)
    })
    req.on('end', () => {
      handleLogBody(Buffer.concat(chunks).toString('utf-8'), entryName)
      res.writeHead(204, CORS_HEADERS)
      res.end()
    })
    req.on('error', () => res.destroy())
    return
  }
  if (path === '/__even-loader/log' && req.method === 'GET') {
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(remoteLogBuffer.length > 0 ? remoteLogBuffer.join('\n') + '\n' : '(ログなし)\n')
    return
  }
  if (path === '/__even-loader/shim.js') {
    let shim: string
    try {
      // リクエスト毎に読み直す: シム更新がプロキシ再起動なしで反映される
      shim = readFileSync(SHIM_PATH, 'utf-8')
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`even-loader-shim.js を読めません: ${e}`)
      return
    }
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(shim)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found (even-loader proxy)')
}

// ─── リスナー起動 ──────────────────────────────────────────────────────
function startEntry(entry: TargetEntry): http.Server {
  const proxy = createProxyServer({
    target: entry.target,
    changeOrigin: true, // Host をターゲットに書き換え (allowedHosts 未設定対策)
    ws: true,
    selfHandleResponse: true, // レスポンスはこちらで書く (HTML 注入のため)
  })

  proxy.on('proxyReq', (proxyReq) => {
    // 上流に非圧縮で返させる (圧縮展開せずに HTML を書き換えるため)
    proxyReq.removeHeader('accept-encoding')
  })

  proxy.on('proxyRes', (proxyRes, _req, res) => {
    const serverRes = res as http.ServerResponse
    const contentType = String(proxyRes.headers['content-type'] ?? '')
    const isHtml = contentType.toLowerCase().includes('text/html')

    if (!isHtml) {
      // HTML 以外はヘッダごと素通し (バイト同一)
      serverRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
      proxyRes.pipe(serverRes)
      return
    }

    const chunks: Buffer[] = []
    proxyRes.on('data', (c: Buffer) => chunks.push(c))
    proxyRes.on('end', () => {
      const original = Buffer.concat(chunks).toString('utf-8')
      const injected = injectIntoHtml(original)
      const headers = { ...proxyRes.headers }
      delete headers['content-length']
      delete headers['transfer-encoding']
      headers['content-length'] = String(Buffer.byteLength(injected))
      serverRes.writeHead(proxyRes.statusCode ?? 200, headers)
      serverRes.end(injected)
    })
    proxyRes.on('error', () => serverRes.destroy())
  })

  proxy.on('error', (err, _req, res) => {
    // ターゲット未起動などの接続エラー。HTTP なら 502 ページ、WS ならソケット破棄。
    if (res instanceof http.ServerResponse) {
      send502(res, entry, err as Error)
    } else if (res) {
      ;(res as import('node:net').Socket).destroy()
    }
    console.log(`[proxy:${entry.name}] error: ${(err as Error).message}`)
  })

  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/__even-loader/')) {
      serveOwn(req, res, entry.name)
      return
    }
    console.log(`[req:${entry.name}] ${req.socket.remoteAddress} ${req.method} ${url}`)
    proxy.web(req, res)
  })

  // WebSocket (Vite HMR 等) のアップグレードも透過転送
  server.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket, head)
  })

  server.listen(entry.port, '0.0.0.0', () => {
    const hosts = listenHostHints()
    const urls = hosts.map((h) => `http://${h}:${entry.port}`).join(' , ')
    console.log(`[proxy:${entry.name}] ${urls} -> ${entry.target}`)
  })
  return server
}

// LAN / tailnet で使えそうなホスト名候補 (ローダーに登録する URL のヒント)
function listenHostHints(): string[] {
  const hosts = ['localhost']
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) hosts.push(iface.address)
    }
  }
  return hosts
}

// ─── main ──────────────────────────────────────────────────────────────
const targets = loadTargets()
console.log(`even-loader proxy: ${targets.length} 件のマッピングを起動します (targets.json)`)
console.log('規約: プロキシポート = ターゲットポート + 1000 / ローダーにはプロキシ側 URL を登録する')
const servers = targets.map(startEntry)

function shutdown(): void {
  console.log('even-loader proxy: 停止します')
  for (const s of servers) s.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
