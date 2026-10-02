// 截图取词（OCR）页面：加载工作线程捕获的可见区域截图，框选 → 裁剪 → OCR → 翻译 → 收藏。
import type { TranslationResult } from '../shared/types';

const OCR_LANGS = 'jpn+eng';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;
const marquee = document.getElementById('marquee') as HTMLElement;
const tip = document.getElementById('tip') as HTMLElement;
const textEl = document.getElementById('text') as HTMLTextAreaElement;
const translationEl = document.getElementById('translation') as HTMLElement;
const translateBtn = document.getElementById('translate') as HTMLButtonElement;
const favoriteBtn = document.getElementById('favorite') as HTMLButtonElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;

interface RectH { x: number; y: number; w: number; h: number; }
interface Prefs { sourceLang?: string; targetLang?: string; }

let img: HTMLImageElement | null = null;
let selection: RectH | null = null;
let lastTranslation: TranslationResult | null = null;
let sourceUrl = '';
let prefs: Prefs = {};
let ocrId = 0;
let dragging = false;
let startX = 0;
let startY = 0;

// ── 沙箱 OCR 计算子页面 ──
const sandbox = document.createElement('iframe');
sandbox.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
sandbox.src = chrome.runtime.getURL('src/ocr/sandbox.html');
document.body.appendChild(sandbox);

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'OCR_RESULT' || d.id !== ocrId) return;
  if (d.error) {
    textEl.value = `OCR 失败：${d.error}`;
  } else {
    textEl.value = d.text || '(未识别到文字)';
    void runTranslate();
  }
});

async function loadImage(): Promise<void> {
  const got = await chrome.storage.session.get(['ocrImage', 'ocrSourceUrl', 'ocrSourceTitle']);
  const dataUrl = got.ocrImage as string | undefined;
  sourceUrl = (got.ocrSourceUrl as string) ?? '';
  if (!dataUrl) return;
  document.title = `截图取词 — ${got.ocrSourceTitle || ''}`;
  const image = new Image();
  await new Promise<void>((res) => { image.onload = () => res(); image.src = dataUrl; });
  img = image;
  tip.style.display = 'none';
  fitAndDraw();
}

function fitAndDraw(): void {
  if (!img) return;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.style.width = (img.naturalWidth * scale) + 'px';
  canvas.style.height = (img.naturalHeight * scale) + 'px';
  canvas.style.left = ((cw - img.naturalWidth * scale) / 2) + 'px';
  canvas.style.top = ((ch - img.naturalHeight * scale) / 2) + 'px';
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(img, 0, 0);
}

// 视口坐标 → 图片自然坐标
function viewportToImage(x: number, y: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return {
    x: (x - r.left) / r.width * img!.naturalWidth,
    y: (y - r.top) / r.height * img!.naturalHeight,
  };
}

function toImageRect(vp: RectH): RectH {
  const p1 = viewportToImage(vp.x, vp.y);
  const p2 = viewportToImage(vp.x + vp.w, vp.y + vp.h);
  const x1 = Math.max(0, Math.round(Math.min(p1.x, p2.x)));
  const y1 = Math.max(0, Math.round(Math.min(p1.y, p2.y)));
  const x2 = Math.min(img!.naturalWidth, Math.round(Math.max(p1.x, p2.x)));
  const y2 = Math.min(img!.naturalHeight, Math.round(Math.max(p1.y, p2.y)));
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

function cropToDataUrl(r: RectH): string {
  const c = document.createElement('canvas');
  c.width = r.w;
  c.height = r.h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c.toDataURL('image/png');
}

function runOcr(): void {
  if (!img || !selection) return;
  const r = toImageRect(selection);
  if (r.w < 2 || r.h < 2) return;
  const dataUrl = cropToDataUrl(r);
  textEl.value = '识别中…';
  translationEl.textContent = '';
  favoriteBtn.disabled = true;
  lastTranslation = null;
  ocrId++;
  sandbox.contentWindow?.postMessage({ type: 'OCR_REQUEST', id: ocrId, image: dataUrl, langs: OCR_LANGS }, '*');
}

async function runTranslate(): Promise<void> {
  const text = textEl.value.trim();
  if (!text) return;
  translationEl.textContent = '翻译中…';
  favoriteBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      text,
      sourceLang: prefs.sourceLang || 'auto',
      targetLang: prefs.targetLang || 'zh',
      sourceUrl,
    });
    if (resp?.type === 'TRANSLATE_RESULT') {
      lastTranslation = resp.translation as TranslationResult;
      translationEl.textContent = lastTranslation.text;
      favoriteBtn.disabled = false;
    } else {
      translationEl.textContent = resp?.error ?? '翻译失败';
    }
  } catch {
    translationEl.textContent = '翻译失败，请检查翻译源设置';
  }
}

// ── 拖拽框选 ──
stage.addEventListener('mousedown', (e) => {
  if (!img) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  selection = { x: startX, y: startY, w: 0, h: 0 };
  marquee.style.display = 'block';
  marquee.style.left = startX + 'px';
  marquee.style.top = startY + 'px';
  marquee.style.width = '0px';
  marquee.style.height = '0px';
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !img) return;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  marquee.style.left = x + 'px';
  marquee.style.top = y + 'px';
  marquee.style.width = Math.abs(e.clientX - startX) + 'px';
  marquee.style.height = Math.abs(e.clientY - startY) + 'px';
});

window.addEventListener('mouseup', () => {
  if (!dragging || !img) return;
  dragging = false;
  const w = parseFloat(marquee.style.width);
  const h = parseFloat(marquee.style.height);
  if (w < 5 || h < 5) {
    marquee.style.display = 'none';
    selection = null;
    return;
  }
  selection = {
    x: parseFloat(marquee.style.left),
    y: parseFloat(marquee.style.top),
    w,
    h,
  };
  runOcr();
});

window.addEventListener('resize', () => { if (img) fitAndDraw(); });

// ── 按钮 ──
translateBtn.addEventListener('click', () => void runTranslate());

favoriteBtn.addEventListener('click', async () => {
  const word = textEl.value.trim();
  if (!word || !lastTranslation) return;
  try {
    await chrome.runtime.sendMessage({
      type: 'TOGGLE_FAVORITE',
      word,
      translation: lastTranslation,
      sourceUrl,
      lemma: lastTranslation.lemma,
    });
    favoriteBtn.disabled = true;
    favoriteBtn.textContent = '已收藏';
  } catch { /* 忽略 */ }
});

closeBtn.addEventListener('click', () => {
  chrome.tabs.getCurrent((t) => { if (t?.id) void chrome.tabs.remove(t.id); });
});

// 预取语言偏好
chrome.storage.sync.get(['preferences']).then(d => {
  prefs = (d as { preferences?: Prefs })?.preferences ?? {};
}).catch(() => {});

void loadImage();