// 沙箱页：无 chrome.* 权限，仅负责 Tesseract.js OCR 计算，通过 postMessage 与 OCR 页通信。
const Tesseract = (window as any).Tesseract;

window.addEventListener('message', (e) => {
  const msg = (e.data || {}) as { type?: string; id?: number; image?: string; langs?: string };
  if (msg.type !== 'OCR_REQUEST' || typeof msg.id !== 'number' || !msg.image) return;
  const id = msg.id;

  (Tesseract.recognize(msg.image, msg.langs || 'jpn+eng', {
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
  }) as Promise<any>)
    .then((res: any) => {
      (e.source as any)?.postMessage({ type: 'OCR_RESULT', id, text: res?.data?.text || '' }, '*');
    })
    .catch((err: any) => {
      (e.source as any)?.postMessage({ type: 'OCR_RESULT', id, error: String(err?.message || err) }, '*');
    });
});