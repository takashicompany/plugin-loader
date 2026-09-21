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
// 遷移後も bridge が生きているかの検証用に、SDK 呼び出し結果をすべてスマホ画面へ流す
let onLog: (msg: string) => void = () => {}

export function initRenderer(appBridge: EvenAppBridge, logger?: (msg: string) => void): void {
  bridge = appBridge
  if (logger) onLog = logger
}

/** Foreground 再入場後など、レンズページを再生成したいときに呼ぶ */
export function resetPageState(): void {
  startupRendered = false
}

async function logged<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn()
    onLog(`bridge ${label}: OK`)
    return result
  } catch (err) {
    onLog(`bridge ${label}: ERROR ${err}`)
    throw err
  }
}

async function rebuildPage(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): Promise<void> {
  if (!bridge) return
  if (!startupRendered) {
    await logged('createStartUpPageContainer', () =>
      bridge!.createStartUpPageContainer(new CreateStartUpPageContainer(config)))
    startupRendered = true
    return
  }
  await logged('rebuildPageContainer', () =>
    bridge!.rebuildPageContainer(new RebuildPageContainer(config)))
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
  await logged('textContainerUpgrade(main)', () =>
    bridge!.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 2,
        containerName: 'main',
        contentOffset: 0,
        contentLength: 2000,
        content,
      }),
    ))
}
