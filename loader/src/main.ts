import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { onEvenHubEvent, setEventHandlers } from './events'
import {
  applyTranslations,
  getLanguage,
  isLanguage,
  setLanguage,
  t,
  tFmt,
  type Language,
  type StringKey,
} from './i18n'
import {
  initRenderer,
  markPageAlreadyBuilt,
  resetPageState,
  setRendererLog,
  showScreen,
  updateContent,
  updateFooter,
} from './renderer'
import {
  decodeQrFromBase64,
  decodeQrFromFile,
  qrTextToServerUrl,
  startLiveScan,
  stopStream,
  suggestNameFromUrl,
  tryStartCamera,
  type LiveScanHandle,
} from './qrscan'
import {
  consumeReturnFlag,
  isValidServerUrl,
  loadLanguageBridge,
  loadLanguageLocal,
  loadLastConnectOrigin,
  loadServers,
  markNavigateToPlugin,
  markReturnReload,
  saveLanguage,
  saveLastConnectOrigin,
  saveServers,
  stripLoaderParam,
  withLoaderParam,
  type DevServer,
} from './storage'

declare const __APP_VERSION__: string

const BRIDGE_TIMEOUT_MS = 4000
// レンズ main コンテナ (210px, 行高27px) に収まる表示行数
const LIST_VISIBLE = 7
// 遷移直前に "Connecting" フレームをレンズへ送りきるための猶予
const NAVIGATE_DELAY_MS = 400
// 初回描画がホスト側の旧フレームで上書きされた場合に備えた再送までの猶予
const REDRAW_RETRY_MS = 1000

const GLASSES_HEADER = 'Even Loader'

// ─── DOM ───────────────────────────────────────────────────────────────
const bridgeStatusEl = document.getElementById('bridgeStatus') as HTMLSpanElement
const appVersionEl = document.getElementById('appVersion') as HTMLSpanElement
const pageOriginEl = document.getElementById('pageOrigin') as HTMLSpanElement
const serverListEl = document.getElementById('serverList') as HTMLUListElement
const serverListEmptyEl = document.getElementById('serverListEmpty') as HTMLParagraphElement
const formTitleEl = document.getElementById('formTitle') as HTMLHeadingElement
const serverFormEl = document.getElementById('serverForm') as HTMLFormElement
const formNameEl = document.getElementById('formName') as HTMLInputElement
const formUrlEl = document.getElementById('formUrl') as HTMLInputElement
const formErrorEl = document.getElementById('formError') as HTMLDivElement
const formSubmitEl = document.getElementById('formSubmit') as HTMLButtonElement
const formCancelEl = document.getElementById('formCancel') as HTMLButtonElement
const logEl = document.getElementById('log') as HTMLPreElement
const qrAddBtnEl = document.getElementById('qrAddBtn') as HTMLButtonElement
const qrFileInputEl = document.getElementById('qrFileInput') as HTMLInputElement
const qrErrorEl = document.getElementById('qrError') as HTMLDivElement
const qrModalEl = document.getElementById('qrModal') as HTMLDivElement
const qrVideoEl = document.getElementById('qrVideo') as HTMLVideoElement
const qrCancelBtnEl = document.getElementById('qrCancelBtn') as HTMLButtonElement
const langSelectEl = document.getElementById('langSelect') as HTMLSelectElement

// ─── State ─────────────────────────────────────────────────────────────
let bridge: EvenAppBridge | null = null
let servers: DevServer[] = []
let cursor = 0            // レンズ/WebView 共通の選択位置
let listStart = 0         // レンズ表示窓の先頭 index (カーソル追従)
let editingIndex: number | null = null
let navigating = false    // 遷移開始後の多重操作ガード (= Connecting 状態)
let connectCancelled = false // Connecting 中のダブルタップで中止されたか (connectTo が参照)
let bridgeStatusKey: StringKey = 'statusChecking' // 現在のブリッジ状態 (言語切替時の再適用用)

// ─── i18n ──────────────────────────────────────────────────────────────
// 状態依存の動的文字列 (data-i18n では表せないもの) を現在言語で設定し直す
function applyDynamicTexts(): void {
  bridgeStatusEl.textContent = t(bridgeStatusKey)
  if (editingIndex !== null) {
    formTitleEl.textContent = tFmt('formTitleEdit', { name: servers[editingIndex]?.name ?? '' })
    formSubmitEl.textContent = t('btnUpdate')
  } else {
    formTitleEl.textContent = t('formTitleAdd')
    formSubmitEl.textContent = t('btnAdd')
  }
  langSelectEl.value = getLanguage()
}

async function changeLanguage(lang: Language): Promise<void> {
  if (lang === getLanguage()) return
  setLanguage(lang)
  await saveLanguage(bridge, lang) // localStorage + bridge の二重書き込み
  applyTranslations()
  applyDynamicTexts()
  renderServerList() // 一覧内のボタンラベルを作り直す
  log(`言語切替: ${lang}`)
  // レンズはフル再描画 (boot 済みセッションなので rebuild 経路になる)
  await renderGlassesFull()
}

langSelectEl.addEventListener('change', () => {
  const v = langSelectEl.value
  if (isLanguage(v)) void changeLanguage(v)
})

// ─── Logging ───────────────────────────────────────────────────────────
const LOG_MAX_LINES = 100
function log(msg: string): void {
  const time = new Date().toLocaleTimeString()
  const lines = (`[${time}] ${msg}\n` + (logEl.textContent ?? '')).split('\n')
  logEl.textContent = lines.length > LOG_MAX_LINES ? lines.slice(0, LOG_MAX_LINES).join('\n') : lines.join('\n')
  console.log(`[even-loader] ${msg}`)
  remoteLog(`[${time}] ${msg}`)
}

// ─── Remote logging ────────────────────────────────────────────────────
// 実機では .ehpk ローダーの console が見えないため、既存ログと同じ内容を
// プロキシの /__even-loader/log へ POST する (proxy/server.ts が CORS 対応済み)。
// 送信先: 直近接続したオリジン + 登録済み接続先のオリジン (最大3件)。
// 失敗はすべて黙殺 (本番で害を出さない)。Content-Type は text/plain にして
// CORS プリフライトを不要にする (simple request)。
const REMOTE_LOG_PATH = '/__even-loader/log'
const REMOTE_LOG_MAX_TARGETS = 3
const REMOTE_LOG_PENDING_MAX = 200
let remoteLogTargets: string[] = []
const remoteLogPending: string[] = []

function sendRemoteLine(line: string): void {
  const body = JSON.stringify({ src: 'loader', origin: location.origin, msg: line })
  for (const origin of remoteLogTargets) {
    try {
      void fetch(origin + REMOTE_LOG_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body,
        keepalive: true, // 遷移直前 (pagehide 前後) のログも送りきる
      }).catch(() => { /* 黙殺 */ })
    } catch { /* 黙殺 */ }
  }
}

function remoteLog(line: string): void {
  if (remoteLogTargets.length === 0) {
    if (remoteLogPending.length < REMOTE_LOG_PENDING_MAX) remoteLogPending.push(line)
    return
  }
  sendRemoteLine(line)
}

function setRemoteLogTargets(origins: string[]): void {
  const unique: string[] = []
  for (const o of origins) {
    if (!o || !o.startsWith('http')) continue
    if (o === location.origin) continue // 自分自身には送らない
    if (!unique.includes(o)) unique.push(o)
    if (unique.length >= REMOTE_LOG_MAX_TARGETS) break
  }
  if (unique.length === 0) return
  remoteLogTargets = unique
  const pending = remoteLogPending.splice(0)
  for (const l of pending) sendRemoteLine(l)
}

function serverOrigins(list: DevServer[]): string[] {
  const out: string[] = []
  for (const s of list) {
    try { out.push(new URL(s.url).origin) } catch { /* ignore */ }
  }
  return out
}

// ─── Glasses ───────────────────────────────────────────────────────────
function clampCursor(): void {
  cursor = Math.max(0, Math.min(cursor, servers.length - 1))
  if (servers.length === 0) cursor = 0
}

function buildGlassesContent(): string {
  if (servers.length === 0) {
    return t('glassesEmpty')
  }
  clampCursor()
  // カーソル追従窓: 窓外に出た時だけ最小限スライドする
  if (cursor < listStart) {
    listStart = cursor
  } else if (cursor >= listStart + LIST_VISIBLE) {
    listStart = cursor - LIST_VISIBLE + 1
  }
  listStart = Math.max(0, Math.min(listStart, Math.max(0, servers.length - LIST_VISIBLE)))

  const lines: string[] = []
  for (let i = listStart; i < Math.min(listStart + LIST_VISIBLE, servers.length); i++) {
    const mark = i === cursor ? '▶ ' : '  '
    lines.push(`${mark}${i + 1}. ${servers[i].name}`)
  }
  return lines.join('\n')
}

function buildGlassesFooter(): string {
  if (servers.length === 0) return t('glassesFooter')
  return `${t('glassesFooter')} (${cursor + 1}/${servers.length})`
}

async function renderGlassesFull(): Promise<void> {
  if (!bridge) return
  try {
    await showScreen(GLASSES_HEADER, buildGlassesContent(), buildGlassesFooter())
  } catch (err) {
    log(`レンズ描画エラー: ${err}`)
  }
}

async function refreshGlassesList(): Promise<void> {
  if (!bridge) return
  try {
    await updateContent(buildGlassesContent())
    await updateFooter(buildGlassesFooter())
  } catch (err) {
    log(`レンズ更新エラー: ${err}`)
  }
}

function moveCursor(delta: number): void {
  if (navigating || servers.length === 0) return
  const next = Math.max(0, Math.min(servers.length - 1, cursor + delta))
  if (next === cursor) return
  cursor = next
  renderServerList()
  void refreshGlassesList()
}

// ─── Connect (共通経路: レンズ CLICK とスマホ「接続」ボタン) ─────────────
async function connectTo(index: number): Promise<void> {
  if (navigating) return
  const s = servers[index]
  if (!s) return
  if (!isValidServerUrl(s.url)) {
    log(`不正なURLのため接続中止: ${s.url}`)
    return
  }
  navigating = true
  connectCancelled = false
  log(`接続: ${s.name} → ${s.url}`)
  await saveServers(bridge, servers)
  if (bridge) {
    try {
      // 遷移前にレンズへフィードバックを出し、フレームが届くのを少し待つ
      await updateContent(`Connecting: ${s.name}...`)
      await updateFooter(s.url)
      await new Promise((r) => setTimeout(r, NAVIGATE_DELAY_MS))
    } catch (err) {
      log(`Connecting表示エラー: ${err}`)
    }
  }
  // flush 待ちの間にダブルタップで中止された場合は遷移しない
  if (connectCancelled) return
  // 復帰後の初回描画を rebuildPageContainer にするためのフラグを立てる
  // (ホスト側セッションでは createStartUpPageContainer が 1 回きりのため)
  await markNavigateToPlugin(bridge)
  // 復帰後のリモートログ送信先として直近接続オリジンを保存
  await saveLastConnectOrigin(bridge, s.url)
  // フラグ保存中に中止された場合も遷移しない (立てたフラグは撤回する)
  if (connectCancelled) {
    void consumeReturnFlag(bridge)
    return
  }
  // even_loader=1 を付与して遷移する。遷移先に even-loader-shim.js が入っていれば
  // 「ダブルタップ終了」が history.back() (ローダーへ戻る) に差し替わる。
  location.assign(withLoaderParam(s.url))
}

// ─── Connecting 中止 ───────────────────────────────────────────────────
// 接続先が存在しない/応答しない場合、location.assign 後も WebView は現ページに
// 留まり「Connecting: <name>...」のまま固まる。この間のダブルタップで
// 保留中の遷移を中止して一覧画面へ戻す。
// (遷移が成功した場合はページごと破棄されるのでこの処理は発火しない)
async function cancelConnecting(): Promise<void> {
  if (!navigating) return
  connectCancelled = true
  navigating = false
  log('接続を中止しました (Connecting中のダブルタップ)')
  // 保留中のトップレベル遷移を中止
  try { window.stop() } catch { /* ignore */ }
  // 遷移前に立てた復帰フラグを撤回 (遷移しなかったので次回 boot は通常経路でよい)
  try { await consumeReturnFlag(bridge) } catch { /* ignore */ }
  // レンズを一覧へ戻す。このセッションのページは構築済みなので
  // 復帰時と同じ rebuild 経路 (結果ログ + 失敗時 create フォールバック +
  // 800ms ガード再描画) を流用する。
  markPageAlreadyBuilt()
  await renderGlassesFull()
}

// ─── Persist ───────────────────────────────────────────────────────────
async function persist(): Promise<void> {
  await saveServers(bridge, servers)
}

// ─── Phone UI ──────────────────────────────────────────────────────────
function renderServerList(): void {
  clampCursor()
  serverListEl.innerHTML = ''
  serverListEmptyEl.hidden = servers.length > 0
  servers.forEach((s, i) => {
    const li = document.createElement('li')
    li.className = 'server-item' + (i === cursor ? ' selected' : '')

    const name = document.createElement('div')
    name.className = 'server-name'
    name.textContent = `${i + 1}. ${s.name}`
    li.appendChild(name)

    const url = document.createElement('div')
    url.className = 'server-url'
    url.textContent = s.url
    li.appendChild(url)

    const actions = document.createElement('div')
    actions.className = 'server-actions'
    const mkBtn = (label: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      if (cls) b.className = cls
      b.disabled = disabled
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
      actions.appendChild(b)
      return b
    }
    mkBtn(t('btnConnect'), 'connect', () => { void connectTo(i) })
    mkBtn('↑', '', () => { void moveServer(i, -1) }, i === 0)
    mkBtn('↓', '', () => { void moveServer(i, 1) }, i === servers.length - 1)
    mkBtn(t('btnEdit'), '', () => beginEdit(i))
    mkBtn(t('btnDelete'), 'danger', () => { void removeServer(i) })
    li.appendChild(actions)

    li.addEventListener('click', () => {
      if (cursor === i) return
      cursor = i
      renderServerList()
      void refreshGlassesList()
    })
    serverListEl.appendChild(li)
  })
}

async function moveServer(index: number, delta: number): Promise<void> {
  const to = index + delta
  if (to < 0 || to >= servers.length) return
  const [item] = servers.splice(index, 1)
  servers.splice(to, 0, item)
  if (cursor === index) cursor = to
  else if (cursor === to) cursor = index
  if (editingIndex === index) editingIndex = to
  else if (editingIndex === to) editingIndex = index
  renderServerList()
  await persist()
  void refreshGlassesList()
}

async function removeServer(index: number): Promise<void> {
  const s = servers[index]
  if (!s) return
  if (!confirm(tFmt('confirmDelete', { name: s.name }))) return
  servers.splice(index, 1)
  if (editingIndex === index) cancelEdit()
  else if (editingIndex !== null && editingIndex > index) editingIndex--
  clampCursor()
  renderServerList()
  await persist()
  log(`削除: ${s.name}`)
  void refreshGlassesList()
}

function beginEdit(index: number): void {
  const s = servers[index]
  if (!s) return
  editingIndex = index
  formNameEl.value = s.name
  formUrlEl.value = s.url
  formCancelEl.hidden = false
  setFormError('')
  applyDynamicTexts() // タイトル/ボタンを編集モードの文言に (現在言語)
  formNameEl.focus()
}

function cancelEdit(): void {
  editingIndex = null
  serverFormEl.reset()
  formCancelEl.hidden = true
  setFormError('')
  applyDynamicTexts() // タイトル/ボタンを追加モードの文言に (現在言語)
}

function setFormError(msg: string): void {
  formErrorEl.textContent = msg
  formErrorEl.hidden = !msg
}

serverFormEl.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = formNameEl.value.trim()
  // even_loader は遷移時に付け直すため、保存 URL からは取り除く
  const url = stripLoaderParam(formUrlEl.value.trim())
  if (!isValidServerUrl(url)) {
    setFormError(t('errInvalidUrl'))
    return
  }
  const entry: DevServer = { name: name || url, url }
  if (editingIndex !== null) {
    servers[editingIndex] = entry
    log(`更新: ${entry.name}`)
  } else {
    servers.push(entry)
    cursor = servers.length - 1
    log(`追加: ${entry.name}`)
  }
  cancelEdit()
  renderServerList()
  void persist()
  void refreshGlassesList()
})

formCancelEl.addEventListener('click', () => cancelEdit())

// ─── QRで追加 ──────────────────────────────────────────────────────────
// evenhub qr が生成する QR (ペイロード = dev server の URL) を読み取り、
// 追加フォームへプリフィルする。3段構えで環境差を吸収する:
//   A1. bridge.captureImageFromCamera (SDK 0.0.11+, app.json camera 権限)
//       — Even アプリの正規経路。ネイティブのカメラUIで1枚撮影して base64 を受け取る
//   A2. getUserMedia ライブプレビュー — ブラウザ単体などで動く場合のみ
//   B.  <input type="file" capture> — 撮影/写真選択の最終フォールバック
// 判定は実行時: A1 はメソッド有無、A2 は getUserMedia の成否で決める。

let qrScanHandle: LiveScanHandle | null = null
let qrStream: MediaStream | null = null
let qrBusy = false

function setQrError(msg: string): void {
  qrErrorEl.textContent = msg
  qrErrorEl.hidden = !msg
}

function applyQrText(text: string, via: string): void {
  const url = qrTextToServerUrl(text)
  if (!url) {
    log(`QR読み取り(${via}): URL以外の内容でした`)
    setQrError(t('qrErrNotUrl') + text.slice(0, 80))
    return
  }
  // 追加フォームへプリフィル (編集中なら編集を破棄して追加モードへ)
  cancelEdit()
  formUrlEl.value = stripLoaderParam(url)
  formNameEl.value = suggestNameFromUrl(url)
  setQrError('')
  log(`QR読み取り成功(${via}): ${url} — 内容を確認して「追加」を押してください`)
  formNameEl.focus()
}

function closeQrModal(): void {
  qrModalEl.hidden = true
  if (qrScanHandle) { qrScanHandle.stop(); qrScanHandle = null }
  if (qrStream) { stopStream(qrStream); qrStream = null }
  qrVideoEl.srcObject = null
}

qrCancelBtnEl.addEventListener('click', () => {
  closeQrModal()
  log('QR読み取りをキャンセルしました')
})

// SDK は Flutter ハンドラが無くても bridge 単例を初期化してしまう
// (呼び出しは "Flutter handler not available" で null 解決)。
// ネイティブ経路が本当に生きているかは callHandler の有無で判定する。
function hasNativeBridgeTransport(): boolean {
  const w = window as unknown as { flutter_inappwebview?: { callHandler?: unknown } }
  return typeof w.flutter_inappwebview?.callHandler === 'function'
}

// A1: Even ブリッジのネイティブカメラで1枚撮影してデコード
async function scanViaBridgeCamera(): Promise<boolean> {
  if (!bridge || typeof bridge.captureImageFromCamera !== 'function') return false
  if (!hasNativeBridgeTransport()) return false
  log('QR読み取り: アプリのカメラを起動します (captureImageFromCamera)')
  let asset: Awaited<ReturnType<typeof bridge.captureImageFromCamera>>
  try {
    asset = await bridge.captureImageFromCamera()
  } catch (err) {
    log(`captureImageFromCamera エラー: ${err} — 別の方法を試します`)
    return false
  }
  if (!asset || !asset.base64) {
    // キャンセルまたは権限拒否 (仕様上どちらも null)
    log('QR読み取り: 撮影がキャンセルされたか、カメラ権限がありません')
    return true // 経路自体は生きているので他の経路へは落とさない
  }
  const result = await decodeQrFromBase64(asset.base64, asset.mimeType)
  if (result.ok) {
    applyQrText(result.text, 'カメラ撮影')
  } else {
    setQrError(t('qrErrDecodeCamera'))
    log(`QRデコード失敗(カメラ撮影): ${result.reason}`)
  }
  return true
}

// A2: getUserMedia ライブプレビュー + 連続デコード
async function scanViaLiveCamera(): Promise<boolean> {
  const stream = await tryStartCamera()
  if (!stream) return false
  qrStream = stream
  qrVideoEl.srcObject = stream
  qrModalEl.hidden = false
  try { await qrVideoEl.play() } catch { /* autoplay 済みなら無視 */ }
  log('QR読み取り: ライブカメラでスキャン中 (getUserMedia)')
  qrScanHandle = startLiveScan(qrVideoEl, (text) => {
    closeQrModal()
    applyQrText(text, 'ライブスキャン')
  })
  return true
}

// B: file input (capture="environment") — change ハンドラでデコード
qrFileInputEl.addEventListener('change', () => {
  const file = qrFileInputEl.files?.[0]
  qrFileInputEl.value = '' // 同じファイルの再選択でも change が発火するように
  if (!file) return
  log(`QR読み取り: 画像を受領 (${file.type || 'unknown'}, ${file.size} bytes)`)
  void decodeQrFromFile(file).then((result) => {
    if (result.ok) {
      applyQrText(result.text, '画像')
    } else if (result.reason === 'load-error') {
      setQrError(t('qrErrImageLoad'))
      log('QRデコード失敗(画像): 読み込みエラー')
    } else {
      setQrError(t('qrErrDecodeImage'))
      log('QRデコード失敗(画像): QRが見つかりません')
    }
  })
})

qrAddBtnEl.addEventListener('click', () => {
  if (qrBusy) return
  qrBusy = true
  setQrError('')
  void (async () => {
    try {
      if (await scanViaBridgeCamera()) return
      if (await scanViaLiveCamera()) return
      log('QR読み取り: カメラAPIが使えないため写真の撮影/選択で読み取ります')
      qrFileInputEl.click()
    } catch (err) {
      log(`QR読み取りエラー: ${err}`)
      setQrError(t('qrErrStart'))
    } finally {
      qrBusy = false
    }
  })()
})

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
  setRendererLog(log) // renderer の描画結果ログもスマホ画面 + リモートログへ

  // 言語: デフォルト英語。localStorage の保存値を即時反映 (ちらつき防止) し、
  // bridge 接続後に bridge 側の保存値 (.ehpk では本命) で上書きする。
  const localLang = loadLanguageLocal()
  if (isLanguage(localLang)) setLanguage(localLang)
  applyTranslations()
  applyDynamicTexts()

  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
    bridgeStatusKey = 'statusConnected'
    bridgeStatusEl.className = 'status-value ok'
    log('Even bridge 接続')
  } catch {
    bridgeStatusKey = 'statusNoBridge'
    bridgeStatusEl.className = 'status-value err'
    log('Even bridge なし — スマホUIのみで動作します')
  }
  bridgeStatusEl.textContent = t(bridgeStatusKey)

  // bridge 側の言語設定があれば反映 (レンズ初期描画の前に確定させる)
  const bridgeLang = await loadLanguageBridge(bridge)
  if (isLanguage(bridgeLang) && bridgeLang !== getLanguage()) {
    setLanguage(bridgeLang)
    applyTranslations()
    applyDynamicTexts()
  }

  // プラグインからの復帰か判定 (フラグは読んだら即クリア)。
  // 復帰時はホスト側セッションにプラグインのコンテナが残っているため、
  // 初回描画を create ではなく rebuild (全置き換え) にしないと実機で重なる。
  const returning = await consumeReturnFlag(bridge)

  servers = await loadServers(bridge)

  // リモートログ送信先を確定 (直近接続オリジン優先 + 登録済みオリジン)。
  // 確定した時点で、それまで buffer していた boot 初期のログも flush される。
  const lastConnect = await loadLastConnectOrigin(bridge)
  setRemoteLogTargets([...(lastConnect ? [lastConnect] : []), ...serverOrigins(servers)])

  log(`接続先を${servers.length}件ロード`)
  renderServerList()

  if (bridge) {
    initRenderer(bridge)
    if (returning.found) {
      log(`プラグインからの復帰を検出 (経路=${returning.via.join('+')}) — 初回描画を rebuildPageContainer で行います`)
      markPageAlreadyBuilt()
    }
    setEventHandlers({
      onScrollUp: () => moveCursor(-1),
      onScrollDown: () => moveCursor(1),
      onClick: () => { void connectTo(cursor) },
      // Connecting 中 (遷移が保留のまま固まっている間) は終了ではなく接続中止。
      // それ以外は Even Hub 審査要件どおりルート画面のダブルタップで OS 終了ダイアログ。
      onDoubleClick: () => {
        if (navigating) {
          void cancelConnecting()
          return
        }
        void bridge?.shutDownPageContainer(1)
      },
      onForegroundEnter: () => {
        log('foreground enter — レンズ再描画')
        resetPageState()
        void renderGlassesFull()
      },
      onForegroundExit: () => {
        // ページ破棄に備え、次回入場時に createStartUpPageContainer から作り直す
        resetPageState()
      },
      onLog: (msg) => log(msg),
    })
    try {
      await renderGlassesFull()
      bridge.onEvenHubEvent(onEvenHubEvent)
      log('レンズ初期描画 完了')
      // 遷移先プラグインから戻った直後は、ホストが初回描画フレームを旧フレームで
      // 上書きすることがある (evenhub-simulator 0.7.3 実測。以降の updateContent は
      // 正常に反映される)。少し後にもう一度内容を流し込んで表示を確定させる。
      window.setTimeout(() => { void refreshGlassesList() }, REDRAW_RETRY_MS)
    } catch (err) {
      log(`レンズ初期化エラー: ${err}`)
    }
  }
}

boot().catch((err) => {
  log(`Fatal: ${err}`)
})

// 遷移先プラグインから history.back() で戻ってきたときの復帰入口。
// bfcache 復元だと boot() が走り直さず、さらにホストによっては復元後の
// ブリッジ経路が死んでいる (evenhub-simulator 0.7.3 で実測: 復元後は
// Web→App 呼び出しも App→Web イベントも届かなくなる)。
// そのためレンズの再描画ではなく、リロードして通常ロード経路 (boot) に
// 乗せ直すのが確実。ローダーの状態は storage に永続化済みなので失うものはない。
window.addEventListener('pageshow', (e) => {
  log(`pageshow persisted=${e.persisted}`)
  if (!e.persisted) return // 通常ロードは boot() が処理する
  log('pageshow (bfcache復元) — リロードしてローダーを再初期化')
  // bfcache 復元 = プラグインからの復帰が確定。reload 後の boot が
  // 初回描画を rebuild にできるよう、同期的にフラグを立ててからリロードする。
  markReturnReload()
  location.reload()
})
