import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { onEvenHubEvent, setEventHandlers } from './events'
import { initRenderer, resetPageState, showScreen, updateContent } from './renderer'

declare const __APP_VERSION__: string

const BRIDGE_TIMEOUT_MS = 4000

const GLASSES_HEADER = 'Sample App'
const GLASSES_FOOTER = 'タップ:カウント / ダブルタップ:終了'

// ─── DOM ───────────────────────────────────────────────────────────────
const bridgeStatusEl = document.getElementById('bridgeStatus') as HTMLSpanElement
const appVersionEl = document.getElementById('appVersion') as HTMLSpanElement
const pageOriginEl = document.getElementById('pageOrigin') as HTMLSpanElement
const counterValueEl = document.getElementById('counterValue') as HTMLDivElement
const incrementBtn = document.getElementById('incrementBtn') as HTMLButtonElement
const backBtn = document.getElementById('backBtn') as HTMLButtonElement
const logEl = document.getElementById('log') as HTMLPreElement

// ─── State ─────────────────────────────────────────────────────────────
let bridge: EvenAppBridge | null = null
let counter = 0

// ─── Logging ───────────────────────────────────────────────────────────
const LOG_MAX_LINES = 150
function log(msg: string): void {
  const time = new Date().toLocaleTimeString()
  const lines = (`[${time}] ${msg}\n` + (logEl.textContent ?? '')).split('\n')
  logEl.textContent = lines.length > LOG_MAX_LINES ? lines.slice(0, LOG_MAX_LINES).join('\n') : lines.join('\n')
  console.log(`[sample-app] ${msg}`)
}

// ─── Glasses ───────────────────────────────────────────────────────────
function buildGlassesContent(): string {
  return [
    `bridge: ${bridge ? 'OK' : 'NG'}`,
    `count: ${counter}`,
  ].join('\n')
}

async function renderGlassesFull(): Promise<void> {
  if (!bridge) return
  try {
    await showScreen(GLASSES_HEADER, buildGlassesContent(), GLASSES_FOOTER)
  } catch (err) {
    log(`レンズ描画エラー: ${err}`)
  }
}

// ─── Counter (共通経路: G2 CLICK とスマホ +1 ボタン) ─────────────────────
function increment(): void {
  counter++
  counterValueEl.textContent = String(counter)
  log(`カウント: ${counter}`)
  if (bridge) {
    void updateContent(buildGlassesContent()).catch((err) => log(`カウント表示エラー: ${err}`))
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

async function boot(): Promise<void> {
  appVersionEl.textContent = __APP_VERSION__
  pageOriginEl.textContent = location.origin
  log(`起動: origin=${location.origin} referrer=${document.referrer || '(なし)'}`)

  incrementBtn.addEventListener('click', () => increment())
  backBtn.addEventListener('click', () => history.back())

  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
    bridgeStatusEl.textContent = '接続済み (遷移後もbridge有効)'
    bridgeStatusEl.className = 'status-value ok'
    log('bridge waitForEvenAppBridge: OK')
  } catch (err) {
    bridgeStatusEl.textContent = '未接続 (ブラウザ単体モード)'
    bridgeStatusEl.className = 'status-value err'
    log(`bridge waitForEvenAppBridge: ERROR ${err}`)
    return
  }

  initRenderer(bridge, log)
  setEventHandlers({
    onScrollUp: () => log('event: SCROLL_TOP'),
    onScrollDown: () => log('event: SCROLL_BOTTOM'),
    onClick: () => increment(),
    onDoubleClick: () => {
      log('event: DOUBLE_CLICK → shutDownPageContainer(1)')
      void bridge?.shutDownPageContainer(1)
    },
    onForegroundEnter: () => {
      log('event: FOREGROUND_ENTER — レンズ再描画')
      resetPageState()
      void renderGlassesFull()
    },
    onForegroundExit: () => {
      log('event: FOREGROUND_EXIT')
      resetPageState()
    },
    onLog: (msg) => log(msg),
  })

  await renderGlassesFull()
  bridge.onEvenHubEvent(onEvenHubEvent)
  log('レンズ初期描画 完了 — G2タップでカウントが増えれば遷移後のbridgeは正常')
}

boot().catch((err) => {
  log(`Fatal: ${err}`)
})
