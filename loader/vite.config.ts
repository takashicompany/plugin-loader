import { defineConfig, type Plugin } from 'vite'
import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { IncomingMessage, ServerResponse } from 'http'

const projectDir = dirname(fileURLToPath(import.meta.url))
const appJson = JSON.parse(readFileSync(resolve(projectDir, 'app.json'), 'utf-8'))

// even-loader-*.ehpk のうち最新 (semver 最大、パースできない場合は mtime 最新) を返す
function findLatestEhpk(): { path: string; name: string } | null {
  const names = readdirSync(projectDir).filter((f) => /^even-loader-.*\.ehpk$/.test(f))
  if (names.length === 0) return null
  const parseVer = (name: string): number[] | null => {
    const m = name.match(/^even-loader-(\d+)\.(\d+)\.(\d+)\.ehpk$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  names.sort((a, b) => {
    const va = parseVer(a)
    const vb = parseVer(b)
    if (va && vb) {
      for (let i = 0; i < 3; i++) {
        if (va[i] !== vb[i]) return vb[i] - va[i]
      }
      return 0
    }
    if (va) return -1
    if (vb) return 1
    const ma = statSync(resolve(projectDir, a)).mtimeMs
    const mb = statSync(resolve(projectDir, b)).mtimeMs
    return mb - ma
  })
  const name = names[0]
  return { path: resolve(projectDir, name), name }
}

function downloadEhpkHandler(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if ((req.url ?? '').split('?')[0] !== '/download/ehpk') {
    next()
    return
  }
  const latest = findLatestEhpk()
  if (!latest) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'no .ehpk found in loader/. run: npm run pack' }))
    return
  }
  const buf = readFileSync(latest.path)
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${latest.name}"`)
  res.setHeader('Content-Length', String(buf.byteLength))
  res.end(buf)
}

function downloadEhpkPlugin(): Plugin {
  return {
    name: 'download-ehpk',
    // configureServer 内の直接 use() は Vite 内部 middleware より先に登録される
    configureServer(server) {
      server.middlewares.use(downloadEhpkHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(downloadEhpkHandler)
    },
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(appJson.version),
  },
  base: command === 'build' ? './' : '/',
  plugins: [downloadEhpkPlugin()],
  server: {
    host: true,
    port: 5178,
    allowedHosts: true,
  },
}))
