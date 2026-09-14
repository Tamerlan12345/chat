// Вложения в переписке: лимит размера, подписи и рамка картинки в ленте.

// Столько же принимает сервер (server/src/api/index.js). Проверка здесь —
// чтобы отказ был виден сразу, а не после загрузки ста мегабайт.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// «740 КБ», «12,4 МБ», «186 МБ».
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ`;
  return `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ`;
}

// null — можно отправлять; иначе текст причины.
export function uploadProblem(file) {
  if (!file) return 'Файл не выбран';
  if (file.size === 0) return 'Файл пустой';
  if (file.size > MAX_UPLOAD_BYTES) return 'Больше 100 МБ — такой файл отправить нельзя';
  return null;
}

// Размер картинки в ленте. Картинка вписывается в рамку целиком, пока
// пропорции обычные; очень узкие и очень широкие (скриншот страницы,
// панорама) обрезаются рамкой — целиком их видно в просмотре.
export const IMAGE_BOX = { maxWidth: 360, maxHeight: 280, minSide: 120 };

export function imageFrame(width, height, box = IMAGE_BOX) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return { width: box.maxWidth, height: Math.round(box.maxWidth * 0.625), cropped: false };
  const scale = Math.min(1, box.maxWidth / w, box.maxHeight / h);
  let fw = Math.round(w * scale);
  let fh = Math.round(h * scale);
  const cropped = fw < box.minSide || fh < box.minSide;
  fw = Math.max(fw, Math.min(box.minSide, box.maxWidth));
  fh = Math.max(fh, Math.min(box.minSide, box.maxHeight));
  return { width: fw, height: fh, cropped };
}
