// 页面选区读取：把「选中文本 + 定位矩形 + 上下文句子」的提取逻辑从
// content script 抽出来，供内容脚本与扩展自有页面（popup/options/vocab）共用。

export interface SelectionInfo {
  text: string;
  rect: DOMRect;
  context: string;
}

const MAX_TEXT_LENGTH = 20000;

// 从选区中提取上下文句子（选区所在的完整句子）
export function getContext(sel: Selection): string {
  try {
    const range = sel.getRangeAt(0);
    // 获取选区所在段落/父元素的文本
    const container = range.commonAncestorContainer;
    const fullText = container.textContent || "";
    if (!fullText) return "";
    const selStart = range.startOffset;
    // 从选区开始位置向前后扩展到句子边界
    let ctxStart = selStart;
    let ctxEnd = selStart + sel.toString().length;
    // 向前扩展：找到最近的句子分隔符
    for (let i = selStart - 1; i >= 0; i--) {
      if (/[.!?。！？\n]/.test(fullText[i])) { ctxStart = i + 1; break; }
      ctxStart = i;
    }
    // 向后扩展：找到最近的句子分隔符
    for (let i = ctxEnd; i < fullText.length; i++) {
      if (/[.!?。！？\n]/.test(fullText[i])) { ctxEnd = i; break; }
      ctxEnd = i + 1;
    }
    const ctx = fullText.slice(ctxStart, ctxEnd).trim();
    return ctx.length > 0 && ctx.length < 500 ? ctx : "";
  } catch {
    return "";
  }
}

// 选区是否落在输入框 / 富文本编辑区（这类场景通常是在编辑，而非要翻译）
function inEditable(sel: Selection): boolean {
  const activeEl = document.activeElement as HTMLElement | null;
  if (activeEl && (
    activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' ||
    activeEl.isContentEditable ||
    !!activeEl.closest?.('[contenteditable="true"], [contenteditable=""]')
  )) return true;
  const anchorEl = sel.anchorNode?.nodeType === Node.TEXT_NODE
    ? sel.anchorNode.parentElement
    : (sel.anchorNode as HTMLElement | null);
  return !!anchorEl?.closest?.('[contenteditable="true"], [contenteditable=""]');
}

export function readSelection(): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  // 长文本支持：最多 20000 字符（worker 侧自动分块翻译；再长视为误选整页）
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return null;
  if (inEditable(sel)) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return { text, rect, context: getContext(sel) };
}