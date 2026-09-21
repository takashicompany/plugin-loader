import jsQR from 'jsqr'

// QRコード読み取り (「QRで追加」機能)。
// 戦略A: getUserMedia によるライブプレビュー + 連続デコード
//   - iOS WKWebView は 14.3+ で getUserMedia に対応するが、ホストアプリ
//     (Even アプリ) 側の許可実装に依存するため、失敗したら静かに B へ落とす。
// 戦略B: <input type="file" accept="image/*" capture="environment"> で
//   カメラ撮影 (または写真選択) した静止画をデコードする。
//   WebView 一般で追加実装なしに動く堅実な経路。
// デコードは jsqr (純JS, ImageData 入力) を使用。CDN 依存なし。

// 大きな写真はデコード前に縮小する (jsqr の速度と誤検出対策)。
// 1辺の上限を段階的に変えて試す: 解像度が高すぎても低すぎても
// 見つからないことがあるため。
const DECODE_MAX_SIDES = [1024, 1600, 512]

// ライブスキャンのデコード間隔 (ms)。毎フレームは重いので間引く。
const SCAN_INTERVAL_MS = 250
// ライブスキャン時の映像取り込み上限 (1辺)
const LIVE_MAX_SIDE = 640

export type QrDecodeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-qr' | 'load-error' }

function decodeImageData(data: ImageData): string | null {
  const code = jsQR(data.data, data.width, data.height, {
    inversionAttempts: 'attemptBoth',
  })
  const text = code?.data?.trim()
  return text ? text : null
}

function drawToImageData(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxSide: number,
): ImageData | null {
  if (srcW <= 0 || srcH <= 0) return null
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, w, h)
  try {
    return ctx.getImageData(0, 0, w, h)
  } catch {
    return null
  }
}

/** 撮影/選択された画像ファイルから QR を読む (戦略B) */
export async function decodeQrFromFile(file: File | Blob): Promise<QrDecodeResult> {
  let bitmap: ImageBitmap | HTMLImageElement
  let width: number
  let height: number
  try {
    if (typeof createImageBitmap === 'function') {
      const bm = await createImageBitmap(file)
      bitmap = bm
      width = bm.width
      height = bm.height
    } else {
      const img = await loadImageElement(file)
      bitmap = img
      width = img.naturalWidth
      height = img.naturalHeight
    }
  } catch {
    return { ok: false, reason: 'load-error' }
  }
  try {
    for (const maxSide of DECODE_MAX_SIDES) {
      const data = drawToImageData(bitmap, width, height, maxSide)
      if (!data) continue
      const text = decodeImageData(data)
      if (text) return { ok: true, text }
    }
    return { ok: false, reason: 'no-qr' }
  } finally {
    if ('close' in bitmap) {
      try { bitmap.close() } catch { /* ignore */ }
    }
  }
}

/** bridge.captureImageFromCamera() が返す base64 画像から QR を読む (戦略A) */
export async function decodeQrFromBase64(base64: string, mimeType: string): Promise<QrDecodeResult> {
  let blob: Blob
  try {
    // base64 が "data:...;base64,xxxx" 形式でも素の base64 でも受ける
    const raw = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
    const bin = atob(raw)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    blob = new Blob([bytes], { type: mimeType || 'image/jpeg' })
  } catch {
    return { ok: false, reason: 'load-error' }
  }
  return decodeQrFromFile(blob)
}

function loadImageElement(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

/**
 * 戦略A の可否判定を兼ねたカメラ起動。
 * 使えない環境 (mediaDevices 不在 / 権限拒否 / カメラなし) では null を返す。
 * 呼び出し側は null なら戦略B へフォールバックする。
 */
export async function tryStartCamera(): Promise<MediaStream | null> {
  const md = navigator.mediaDevices
  if (!md || typeof md.getUserMedia !== 'function') return null
  try {
    return await md.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    })
  } catch {
    return null
  }
}

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try { track.stop() } catch { /* ignore */ }
  }
}

export type LiveScanHandle = { stop: () => void }

/**
 * <video> の映像を定期的にデコードし、QR を見つけたら onHit を一度だけ呼ぶ。
 * 戻り値の stop() で停止する (onHit 後は自動停止)。
 */
export function startLiveScan(video: HTMLVideoElement, onHit: (text: string) => void): LiveScanHandle {
  let stopped = false
  const timer = window.setInterval(() => {
    if (stopped) return
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */) return
    const data = drawToImageData(video, video.videoWidth, video.videoHeight, LIVE_MAX_SIDE)
    if (!data) return
    const text = decodeImageData(data)
    if (text) {
      stopped = true
      window.clearInterval(timer)
      onHit(text)
    }
  }, SCAN_INTERVAL_MS)
  return {
    stop: () => {
      stopped = true
      window.clearInterval(timer)
    },
  }
}

/** QR ペイロードを接続先 URL として検証し、正規化して返す (不正なら null) */
export function qrTextToServerUrl(text: string): string | null {
  const t = text.trim()
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** URL から接続先名の候補を作る (例: "192.168.1.10:5183") */
export function suggestNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url
  }
}
