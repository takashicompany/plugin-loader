import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// Even Loader シム注入プラグイン。
//
// 開発中プラグインの vite.config.ts に 1 行足すだけで、dev server が返す
// index.html の先頭に even-loader-shim.js がインライン注入される。
// これにより「ローダーから開いたときだけ、ダブルタップ終了が history.back()
// (ローダーへ戻る) に差し替わる」。プラグイン本体のソース変更は不要。
//
// 使い方 (開発中プラグイン側の vite.config.ts):
//   import { evenLoaderInject } from '../../even-loader/tools/even-loader-inject'
//   export default defineConfig({ plugins: [evenLoaderInject()] })
//
// apply: 'serve' なので dev server のみに効き、build 成果物 (.ehpk) には入らない。

const SHIM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../loader/public/even-loader-shim.js',
)

export function evenLoaderInject(): Plugin {
  return {
    name: 'even-loader-inject',
    apply: 'serve',
    transformIndexHtml() {
      // 毎リクエスト読み直すことでシム更新が dev server 再起動なしに反映される
      const shim = readFileSync(SHIM_PATH, 'utf-8')
      return [
        {
          tag: 'script',
          children: shim,
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default evenLoaderInject
