// 扩展自有页面（popup / options / vocab）的轻量「划词翻译」。
// 这些页面跑在扩展自身 origin，content script 不会注入进来；
// 复用共享的选词读取，直接与 worker 通信，弹一个极简浮层。
import { readSelection } from './selection';
import type { TranslationResult } from './types';

const DEBOUNCE_MS = 200;

const SPEAK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const STAR_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

interface Prefs { sourceLang?: string; targetLang?: string; }

function detectPageTheme(): 'light' | 'dark' {
  for (const el of [document.body, document.documentElement]) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
      ? bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/) : null;
    if (m) {
      const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
      return lum > 140 ? 'light' : 'dark';
    }
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function enableInlineTranslate(): void {
  if (!document.body || document.getElementById('hoshibiroi-inline')) return;

  const host = document.createElement('div');
  host.id = 'hoshibiroi-inline';
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  host.dataset.theme = detectPageTheme();
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      .bubble {
        position: absolute;
        min-width: 160px;
        max-width: 340px;
        padding: 10px 12px;
        border-radius: 12px;
        font: 400 14px/20px "SF Pro Text","PingFang SC",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,.18);
        backdrop-filter: blur(12px);
        pointer-events: auto;
      }
      :host([data-theme="light"]) .bubble {
        background: rgba(255,255,255,.94);
        color: #1f2937;
        border: 1px solid rgba(0,0,0,.08);
      }
      :host([data-theme="dark"]) .bubble {
        background: rgba(23,25,35,.94);
        color: #e5e7eb;
        border: 1px solid rgba(255,255,255,.1);
      }
      .word { font: 500 13px/18px "SF Pro Text","PingFang SC",system-ui,sans-serif; opacity:.72; margin-bottom:4px; word-break: break-word; }
      .text { word-break: break-word; }
      .bar { display:flex; gap:2px; margin-top:8px; justify-content:flex-end; align-items:center; }
      button {
        display:inline-flex; align-items:center; justify-content:center;
        width:26px; height:26px; border:none; background:transparent;
        border-radius:6px; cursor:pointer; padding:0;
      }
      :host([data-theme="light"]) button { color:#4b5563; }
      :host([data-theme="dark"]) button { color:#9ca3af; }
      button:hover { background: rgba(127,127,127,.16); }
      button.on { color:#f59e0b; }
      button[hidden] { display:none; }
    </style>
    <div class="bubble" hidden>
      <div class="word"></div>
      <div class="text"></div>
      <div class="bar">
        <button data-act="speak" title="朗读">${SPEAK_ICON}</button>
        <button data-act="fav" title="收藏" hidden>${STAR_ICON}</button>
        <button data-act="close" title="关闭">${CLOSE_ICON}</button>
      </div>
    </div>
  `;

  const bubble = shadow.querySelector('.bubble') as HTMLElement;
  const wordEl = shadow.querySelector('.word') as HTMLElement;
  const textEl = shadow.querySelector('.text') as HTMLElement;
  const speakBtn = shadow.querySelector('[data-act="speak"]') as HTMLElement;
  const favBtn = shadow.querySelector('[data-act="fav"]') as HTMLElement;
  const closeBtn = shadow.querySelector('[data-act="close"]') as HTMLElement;

  let current: { word: string; translation: TranslationResult } | null = null;
  let seq = 0;
  let debounce: number | undefined;
  let prefs: Prefs = {};

  chrome.storage.sync.get(['preferences']).then(d => {
    prefs = (d as { preferences?: Prefs })?.preferences ?? {};
  }).catch(() => {});

  document.body.appendChild(host);

  function hide(): void {
    bubble.hidden = true;
    current = null;
    seq++;
  }

  function showAt(rect: DOMRect): void {
    const bw = bubble.offsetWidth || 200;
    const bh = bubble.offsetHeight || 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left;
    if (left + bw > vw - 8) left = Math.max(8, vw - bw - 8);
    let top = rect.bottom + 8;
    if (top + bh > vh - 8) top = Math.max(8, rect.top - bh - 8);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
  }

  async function translate(word: string, rect: DOMRect): Promise<void> {
    const id = ++seq;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'TRANSLATE',
        text: word,
        sourceLang: prefs.sourceLang || 'auto',
        targetLang: prefs.targetLang || 'zh',
        sourceUrl: location.href,
      });
      if (id !== seq) return; // 已被新的选词/关闭取代
      if (resp?.type === 'TRANSLATE_RESULT') {
        const t = resp.translation as TranslationResult;
        wordEl.textContent = t.phonetic ? `${word}  ${t.phonetic}` : word;
        textEl.textContent = t.text;
        current = { word, translation: t };
        favBtn.hidden = false;
        chrome.runtime.sendMessage({ type: 'CHECK_FAVORITE', word, lemma: t.lemma }).then(r => {
          if (id === seq && r?.type === 'FAVORITE_CHECK_RESULT') {
            favBtn.classList.toggle('on', r.favorited);
          }
        }).catch(() => {});
      } else {
        textEl.textContent = resp?.error ?? '翻译失败';
      }
      showAt(rect);
    } catch {
      if (id !== seq) return;
      textEl.textContent = '翻译失败，请检查翻译源设置';
      showAt(rect);
    }
  }

  document.addEventListener('mouseup', () => {
    if (debounce) clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      const info = readSelection();
      if (!info) { hide(); return; }
      current = null;
      wordEl.textContent = info.text;
      textEl.textContent = '翻译中…';
      favBtn.hidden = true;
      favBtn.classList.remove('on');
      bubble.hidden = false;
      showAt(info.rect);
      translate(info.text, info.rect);
    }, DEBOUNCE_MS);
  });

  // 点击浮层外部 → 收起
  document.addEventListener('mousedown', (e) => {
    if (bubble.hidden) return;
    if (!e.composedPath().includes(bubble)) hide();
  }, true);

  speakBtn.addEventListener('click', () => {
    if (!current) return;
    chrome.runtime.sendMessage({ type: 'SPEAK', text: current.word, lang: 'auto' }).catch(() => {});
  });

  favBtn.addEventListener('click', async () => {
    if (!current) return;
    const { word, translation } = current;
    const prevText = textEl.textContent ?? '';
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'TOGGLE_FAVORITE',
        word,
        translation,
        sourceUrl: location.href,
        lemma: translation.lemma,
      });
      if (resp?.type === 'FAVORITE_RESULT') {
        favBtn.classList.toggle('on', resp.added);
        textEl.textContent = resp.merged ? '已并入生词本' : resp.added ? '已收藏' : '已取消收藏';
        window.setTimeout(() => {
          if (current) textEl.textContent = prevText;
        }, 1500);
      }
    } catch { /* 忽略 */ }
  });

  closeBtn.addEventListener('click', hide);
}