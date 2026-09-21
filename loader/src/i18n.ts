// 簡易 i18n (headlenss/even/src/i18n.ts のパターンを移植)。
// スマホ側 WebView と G2 レンズ表示の双方が同じテーブルを参照する。
//   - スマホ側: data-i18n / data-i18n-placeholder 属性 + applyTranslations() で一括適用。
//     状態依存の動的文字列 (ステータス表示・フォームタイトル等) は main.ts が t() で都度設定。
//   - グラス側: 文字列ビルダー内で t() を呼ぶ。言語変更時はレンズをフル再描画する。
// デフォルトは英語。ログ欄 / console / リモートログは開発者向けのため対象外 (日本語のまま)。

export type Language = 'en' | 'ja'

const STRINGS = {
  // ─── ヘッダー ────────────────────────────────────────────────
  tagline: {
    en: 'Loader that switches the WebView to an in-development plugin dev server',
    ja: '開発中プラグインのdev serverへ切り替えるローダー',
  },

  // ─── ステータス ──────────────────────────────────────────────
  statusHead:      { en: 'Status',                                ja: 'ステータス' },
  statusChecking:  { en: 'Checking…',                             ja: '確認中…' },
  statusConnected: { en: 'Connected',                             ja: '接続済み' },
  statusNoBridge:  { en: 'Not connected (browser-only mode)',     ja: '未接続 (ブラウザ単体モード)' },
  languageLabel:   { en: 'Language',                              ja: '言語' },

  // ─── 接続先一覧 ──────────────────────────────────────────────
  listHead:  { en: 'Dev servers', ja: '接続先一覧' },
  listEmpty: {
    en: 'No servers registered. Add one with the form below.',
    ja: '接続先が未登録です。下のフォームから追加してください。',
  },
  btnConnect: { en: 'Connect', ja: '接続' },
  btnEdit:    { en: 'Edit',    ja: '編集' },
  btnDelete:  { en: 'Delete',  ja: '削除' },
  confirmDelete: { en: 'Delete "{name}"?', ja: '「{name}」を削除しますか?' },

  // ─── 追加/編集フォーム ───────────────────────────────────────
  formTitleAdd:  { en: 'Add a server',        ja: '接続先を追加' },
  formTitleEdit: { en: 'Edit server: {name}', ja: '接続先を編集: {name}' },
  labelName:     { en: 'Name',                ja: '名前' },
  labelUrl:      { en: 'URL',                 ja: 'URL' },
  btnAdd:        { en: 'Add',                 ja: '追加' },
  btnUpdate:     { en: 'Update',              ja: '更新' },
  btnCancel:     { en: 'Cancel',              ja: 'キャンセル' },
  errInvalidUrl: {
    en: 'Enter an absolute URL starting with http:// or https://',
    ja: 'URLは http:// または https:// で始まる絶対URLを指定してください',
  },

  // ─── QR ──────────────────────────────────────────────────────
  qrAddBtn: { en: 'Add via QR', ja: 'QRで追加' },
  qrHint: {
    en: 'Scan an "evenhub qr" code to fill in the URL',
    ja: 'evenhub qr のQRコードを読み取ってURLを入力します',
  },
  qrModalTitle: { en: 'Scan QR code',                       ja: 'QRコードを読み取り' },
  qrModalHint:  { en: 'Point the camera at the QR code',    ja: 'QRコードをカメラに向けてください' },
  qrErrNotUrl:  { en: 'QR code content is not a URL: ',     ja: 'QRコードの内容がURLではありません: ' },
  qrErrDecodeCamera: {
    en: 'Could not read the QR code. Retake the photo with the whole code in frame.',
    ja: 'QRコードを読み取れませんでした。QR全体が写るように撮り直してください。',
  },
  qrErrImageLoad: {
    en: 'Could not load the image. Please try another one.',
    ja: '画像を読み込めませんでした。別の画像でお試しください。',
  },
  qrErrDecodeImage: {
    en: 'Could not read the QR code. Use a sharp image showing the whole code.',
    ja: 'QRコードを読み取れませんでした。QR全体が鮮明に写る画像でお試しください。',
  },
  qrErrStart: { en: 'Failed to start QR scanning.', ja: 'QR読み取りの起動に失敗しました。' },

  // ─── ログ (見出しのみ翻訳。中身は開発者向けのため対象外) ────
  logHead: { en: 'Log', ja: 'ログ' },

  // ─── G2 レンズ ───────────────────────────────────────────────
  glassesFooter: {
    en: 'Scroll:Select / Tap:Connect / 2Tap:Exit',
    ja: 'スクロール:選択 / タップ:接続 / ダブルタップ:終了',
  },
  glassesEmpty: {
    en: 'No servers registered\nAdd one from the phone screen',
    ja: '接続先が未登録です\nスマホ側の画面から追加してください',
  },
} as const

export type StringKey = keyof typeof STRINGS

// デフォルトは英語 (仕様)。保存済み設定は main.ts が boot 時に反映する。
let currentLanguage: Language = 'en'

export function getLanguage(): Language {
  return currentLanguage
}

export function setLanguage(lang: Language): void {
  currentLanguage = lang
}

export function isLanguage(v: unknown): v is Language {
  return v === 'en' || v === 'ja'
}

export function t(key: StringKey): string {
  return STRINGS[key]?.[currentLanguage] ?? key
}

/** {name} 等のプレースホルダを埋める */
export function tFmt(key: StringKey, params: Record<string, string>): string {
  let s = t(key)
  for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, v)
  return s
}

/** WebView 全体に翻訳を反映する。各要素は data-i18n="key" / data-i18n-placeholder="key" を持てる */
export function applyTranslations(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n as StringKey
    if (!key) continue
    el.textContent = t(key)
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder as StringKey
    if (!key) continue
    el.placeholder = t(key)
  }
  document.documentElement.setAttribute('lang', currentLanguage)
}

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ja: '日本語',
}
