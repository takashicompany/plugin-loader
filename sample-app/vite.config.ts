import { defineConfig } from 'vite'
import { readFileSync } from 'fs'

import { evenLoaderInject } from '../tools/even-loader-inject'

const appJson = JSON.parse(readFileSync('./app.json', 'utf-8'))

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(appJson.version),
  },
  base: command === 'build' ? './' : '/',
  // ローダー経由で開いたときだけダブルタップ終了を「ローダーへ戻る」に差し替えるシムを
  // dev server の index.html に注入する (ソース無改変の参照実装)
  plugins: [evenLoaderInject()],
  server: {
    host: true,
    // 5179 は環境によっては他サービスが占有しうるため 5183 を使う
    port: 5183,
    allowedHosts: true,
  },
}))
