import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const HEADER_HEIGHT = 32
const FOOTER_HEIGHT = 40
// 左眼で main container の上端 border が裁ち落とされる個体差対策のオフセット (headlenss 準拠)
const MAIN_TOP_INSET = 6
const CONTENT_TOP = HEADER_HEIGHT + MAIN_TOP_INSET
const CONTENT_HEIGHT = DISPLAY_HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT - MAIN_TOP_INSET // 210

const MAIN_PADDING = 8
const MAIN_BORDER = 1

let bridge: EvenAppBridge | null = null
let startupRendered = false
// 復帰フラグ由来で「ページは既にホスト側に存在する」とみなした場合に true。
// その初回 rebuild が失敗した (= 実は新規セッションだった) 場合は create へフォールバック。
let returnRebuildFallbackArmed = false
// 描画系呼び出しの通し番号 (復帰後ガード再描画の「間に他の描画があったらスキップ」判定用)
let drawSeq = 0
// 復帰後、初回 rebuild の描画フレームがホスト側で取りこぼされる実機対策:
// この時間内に他の描画が無ければフル再描画をもう一度送る
const RETURN_REDRAW_RETRY_MS = 800

// ログ出力先 (main.ts の log() に差し替えられる。リモートログにも乗る)
let logFn: (msg: string) => void = (m) => console.log(`[even-loader] ${m}`)
export function setRendererLog(fn: (msg: string) => void): void {
  logFn = fn
}

export function initRenderer(appBridge: EvenAppBridge): void {
  bridge = appBridge
}

/** Foreground 再入場後など、レンズページを再生成したいときに呼ぶ */
export function resetPageState(): void {
  startupRendered = false
  returnRebuildFallbackArmed = false
}

/**
 * プラグインから復帰した直後の boot で呼ぶ。
 * ホスト側セッションには既にコンテナが存在する (createStartUpPageContainer は
 * セッションにつき 1 回きり) ため、初回描画を create ではなく
 * rebuildPageContainer (全コンテナ置き換え) にする。
 */
export function markPageAlreadyBuilt(): void {
  startupRendered = true
  returnRebuildFallbackArmed = true
}

// 復帰後の初回描画から RETURN_REDRAW_RETRY_MS 後、間に他の描画が無ければ
// 同じ内容でフル再描画を一度だけ再送する (実機の初回フレーム取りこぼし対策)
function scheduleReturnRedraw(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): void {
  const seqAt = drawSeq
  window.setTimeout(() => {
    if (!bridge) return
    if (drawSeq !== seqAt) {
      logFn('復帰後ガード再描画: 間に他の描画があったためスキップ')
      return
    }
    drawSeq++
    logFn(`復帰後ガード再描画: ${RETURN_REDRAW_RETRY_MS}ms 間に他の描画が無いため rebuild を再送`)
    bridge.rebuildPageContainer(new RebuildPageContainer(config)).then(
      (ok) => logFn(`ガード再描画 rebuild 結果=${String(ok)}`),
      (err) => logFn(`ガード再描画 rebuild 失敗: ${err}`),
    )
  }, RETURN_REDRAW_RETRY_MS)
}

async function rebuildPage(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): Promise<void> {
  if (!bridge) return
  drawSeq++
  if (!startupRendered) {
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
    logFn(`初回 createStartUpPageContainer 結果=${String(r)} (0=success)`)
    startupRendered = true
    return
  }
  if (returnRebuildFallbackArmed) {
    // 復帰後の初回描画。フラグが stale (実は新規セッション) だった場合、
    // rebuild は拒否されるはずなので create にフォールバックして自己修復する。
    returnRebuildFallbackArmed = false
    let ok = false
    let errMsg = ''
    try {
      ok = await bridge.rebuildPageContainer(new RebuildPageContainer(config))
    } catch (e) {
      errMsg = String(e)
      ok = false
    }
    logFn(`復帰 rebuild 送信 結果=${String(ok)}${errMsg ? ` error=${errMsg}` : ''}`)
    if (!ok) {
      logFn('復帰 rebuild が拒否されたため createStartUpPageContainer にフォールバック')
      const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
      logFn(`フォールバック create 結果=${String(r)} (0=success)`)
    }
    // 成否によらず、間に他の描画が無ければ一度だけフル再描画を再送する
    scheduleReturnRedraw(config)
    return
  }
  await bridge.rebuildPageContainer(new RebuildPageContainer(config))
}

// 全面透明のイベントキャプチャ用コンテナ (これが無いと scroll/click が届かない)
function evtContainer(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: 1,
    containerName: 'evt',
    content: ' ',
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    isEventCapture: 1,
    paddingLength: 0,
  })
}

export async function showScreen(header: string, content: string, footer: string): Promise<void> {
  await rebuildPage({
    containerTotalNum: 4,
    textObject: [
      evtContainer(),
      new TextContainerProperty({
        containerID: 4,
        containerName: 'header',
        content: header,
        xPosition: 0,
        yPosition: 0,
        width: DISPLAY_WIDTH,
        height: HEADER_HEIGHT,
        isEventCapture: 0,
        paddingLength: 4,
      }),
      new TextContainerProperty({
        containerID: 2,
        containerName: 'main',
        content,
        xPosition: 0,
        yPosition: CONTENT_TOP,
        width: DISPLAY_WIDTH,
        height: CONTENT_HEIGHT,
        isEventCapture: 0,
        paddingLength: MAIN_PADDING,
        borderWidth: MAIN_BORDER,
        borderColor: 13,
        borderRadius: 0,
      }),
      new TextContainerProperty({
        containerID: 3,
        containerName: 'footer',
        content: footer,
        xPosition: 0,
        yPosition: CONTENT_TOP + CONTENT_HEIGHT,
        width: DISPLAY_WIDTH,
        height: FOOTER_HEIGHT,
        isEventCapture: 0,
        paddingLength: 4,
      }),
    ],
  })
}

export async function updateContent(content: string): Promise<void> {
  if (!bridge) return
  drawSeq++
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 2,
      containerName: 'main',
      contentOffset: 0,
      contentLength: 2000,
      content,
    }),
  )
}

export async function updateFooter(footer: string): Promise<void> {
  if (!bridge) return
  drawSeq++
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 3,
      containerName: 'footer',
      contentOffset: 0,
      contentLength: 2000,
      content: footer,
    }),
  )
}
