import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// 接続先一覧の永続化。bridge.setLocalStorage と localStorage の両方へ書き込む。
// インストール済み .ehpk の WebView では browser localStorage が消えることがあるため、
// bridge 側が本命ストアで、browser 側はブラウザ単体テスト用。読み出しは bridge 優先。

const STORAGE_KEY = 'even_loader_servers_v1'
const MAX_SERVERS = 50
const MAX_TEXT_LEN = 500

// ローダー経由で開いたことを遷移先へ伝える URL パラメータ。
// even-loader-shim.js がこれを見て「ダブルタップ終了 → history.back()」へ差し替える。
export const LOADER_PARAM = 'even_loader'

/** 保存用 URL からは even_loader パラメータを取り除く (遷移時に付け直す) */
export function stripLoaderParam(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete(LOADER_PARAM)
    return u.toString()
  } catch {
    return url
  }
}

/** 遷移直前に even_loader=1 を付与した URL を返す */
export function withLoaderParam(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set(LOADER_PARAM, '1')
    return u.toString()
  } catch {
    return url
  }
}

export type DevServer = {
  name: string
  url: string
}

// ─── プラグインからの復帰フラグ ─────────────────────────────────────────
// ローダーが遷移先プラグインから history.back() で戻ってきた直後の boot では、
// ホスト側プラグインセッションにプラグインのコンテナが残っている。
// createStartUpPageContainer はセッションにつき 1 回きり (2 回目は invalid で拒否 or
// 実機で重なり表示) のため、復帰後の初回描画は rebuildPageContainer にする必要がある。
// その判定フラグを 3 経路で永続化する:
//   1. pageshow (bfcache 復元) → reload の直前に sessionStorage へ (最有力・同一セッション確実)
//   2. 遷移直前に sessionStorage へ (back() がフルリロードだった場合の保険)
//   3. 遷移直前に bridge.setLocalStorage へ (.ehpk オリジンの sessionStorage が
//      履歴復帰で生きているか不明なための二重化)
// boot で consume (読んだら即クリア) する。bridge 側の消し忘れが次回起動に持ち越された
// 場合に備え、renderer 側は「復帰 rebuild が失敗したら create にフォールバック」する。

const RETURN_FLAG_KEY = 'even_loader_return_pending_v1'
const LAST_CONNECT_KEY = 'even_loader_last_connect_v1'

/** 遷移直前に呼ぶ: 復帰フラグを sessionStorage + bridge localStorage に立てる */
export async function markNavigateToPlugin(bridge: EvenAppBridge | null): Promise<void> {
  try { sessionStorage.setItem(RETURN_FLAG_KEY, 'nav') } catch { /* ignore */ }
  if (bridge) {
    try { await bridge.setLocalStorage(RETURN_FLAG_KEY, 'nav') } catch { /* ignore */ }
  }
}

/** pageshow (bfcache 復元) → reload の直前に呼ぶ: 同期的に sessionStorage だけ立てる */
export function markReturnReload(): void {
  try { sessionStorage.setItem(RETURN_FLAG_KEY, 'pageshow') } catch { /* ignore */ }
}

export type ReturnFlagResult = {
  found: boolean
  /** 検出経路 (例: ['sessionStorage:pageshow', 'bridge:nav'])。実機診断用 */
  via: string[]
}

/** boot で呼ぶ: 復帰フラグの検出結果と経路を返し、両ストアからクリアする */
export async function consumeReturnFlag(bridge: EvenAppBridge | null): Promise<ReturnFlagResult> {
  const via: string[] = []
  try {
    const s = sessionStorage.getItem(RETURN_FLAG_KEY)
    // '1' は旧バージョンの値 (互換)
    if (s === 'nav' || s === 'pageshow' || s === '1') via.push(`sessionStorage:${s}`)
    sessionStorage.removeItem(RETURN_FLAG_KEY)
  } catch { /* ignore */ }
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(RETURN_FLAG_KEY)
      if (v === 'nav' || v === 'pageshow' || v === '1') via.push(`bridge:${v}`)
      if (v) await bridge.setLocalStorage(RETURN_FLAG_KEY, '')
    } catch { /* ignore */ }
  }
  return { found: via.length > 0, via }
}

// ─── UI 言語設定 ────────────────────────────────────────────────────────
// 既存パターンどおり localStorage + bridge.setLocalStorage の二重書き込み。
// 読み出しは localStorage を即時反映し、bridge 側 (インストール済み .ehpk の本命) で上書きする。
const LANG_KEY = 'even_loader_lang_v1'

/** 同期読み出し (boot 直後のちらつき防止用)。無ければ null */
export function loadLanguageLocal(): string | null {
  try { return localStorage.getItem(LANG_KEY) } catch { return null }
}

/** bridge 側の保存値。無ければ null */
export async function loadLanguageBridge(bridge: EvenAppBridge | null): Promise<string | null> {
  if (!bridge) return null
  try {
    const v = await bridge.getLocalStorage(LANG_KEY)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

export async function saveLanguage(bridge: EvenAppBridge | null, lang: string): Promise<void> {
  try { localStorage.setItem(LANG_KEY, lang) } catch { /* ignore */ }
  if (bridge) {
    try { await bridge.setLocalStorage(LANG_KEY, lang) } catch { /* ignore */ }
  }
}

// ─── 直近接続オリジン (リモートログ送信先の決定に使う) ─────────────────
/** 遷移直前に呼ぶ: 接続先 URL のオリジンを sessionStorage + bridge に保存 */
export async function saveLastConnectOrigin(bridge: EvenAppBridge | null, url: string): Promise<void> {
  let origin = ''
  try { origin = new URL(url).origin } catch { return }
  if (!origin.startsWith('http')) return
  try { sessionStorage.setItem(LAST_CONNECT_KEY, origin) } catch { /* ignore */ }
  if (bridge) {
    try { await bridge.setLocalStorage(LAST_CONNECT_KEY, origin) } catch { /* ignore */ }
  }
}

/** 直近接続オリジンを返す (無ければ null)。sessionStorage 優先、bridge が保険 */
export async function loadLastConnectOrigin(bridge: EvenAppBridge | null): Promise<string | null> {
  try {
    const s = sessionStorage.getItem(LAST_CONNECT_KEY)
    if (s && s.startsWith('http')) return s
  } catch { /* ignore */ }
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(LAST_CONNECT_KEY)
      if (typeof v === 'string' && v.startsWith('http')) return v
    } catch { /* ignore */ }
  }
  return null
}

export function isValidServerUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function sanitizeText(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT_LEN) : fallback
}

// 保存された JSON は信用しない。形が崩れていたら壊れたエントリだけ捨てる。
function parse(json: string | null | undefined): DevServer[] | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json)
    if (!Array.isArray(raw)) return null
    const out: DevServer[] = []
    for (const item of raw.slice(0, MAX_SERVERS)) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const url = stripLoaderParam(sanitizeText(rec.url, ''))
      if (!isValidServerUrl(url)) continue
      out.push({
        name: sanitizeText(rec.name, '').trim() || url,
        url,
      })
    }
    return out
  } catch {
    return null
  }
}

export async function loadServers(bridge: EvenAppBridge | null): Promise<DevServer[]> {
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(STORAGE_KEY)
      const parsed = parse(v)
      if (parsed) return parsed
    } catch {
      // bridge 側に値が無いだけのこともある。下に落とす
    }
  }
  return parse(localStorage.getItem(STORAGE_KEY)) ?? []
}

export async function saveServers(bridge: EvenAppBridge | null, servers: DevServer[]): Promise<void> {
  const json = JSON.stringify(servers.slice(0, MAX_SERVERS))
  try { localStorage.setItem(STORAGE_KEY, json) } catch { /* quota */ }
  if (bridge) {
    try { await bridge.setLocalStorage(STORAGE_KEY, json) } catch { /* ignore */ }
  }
}
