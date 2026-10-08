import test from 'node:test';
import assert from 'node:assert';
import { MAX_UPLOAD_BYTES, formatBytes, uploadProblem, imageFrame } from '../src/renderer/src/lib/attachments.mjs';

test('размер файла по-русски', () => {
  assert.strictEqual(formatBytes(512), '512 Б');
  assert.strictEqual(formatBytes(740 * 1024), '740 КБ');
  assert.strictEqual(formatBytes(4.25 * 1024 * 1024), '4,3 МБ');
  assert.strictEqual(formatBytes(186 * 1024 * 1024), '186 МБ');
});

test('файл больше 100 МБ отсекается до загрузки', () => {
  assert.strictEqual(uploadProblem({ size: MAX_UPLOAD_BYTES }), null);
  // Текст — как у сервера (413) и телефонов: copy-ru upload.too_big.
  assert.strictEqual(uploadProblem({ size: MAX_UPLOAD_BYTES + 1 }), 'Файл больше 100 МБ — такой файл загрузить нельзя');
  assert.match(uploadProblem({ size: 0 }), /пустой/);
});

test('обычное фото вписывается в рамку без обрезки', () => {
  const f = imageFrame(4000, 3000);
  assert.deepStrictEqual(f, { width: 360, height: 270, cropped: false });
  assert.deepStrictEqual(imageFrame(200, 100), { width: 200, height: 120, cropped: true });
});

test('маленькая картинка не растягивается', () => {
  assert.deepStrictEqual(imageFrame(160, 160), { width: 160, height: 160, cropped: false });
});

test('длинный скриншот обрезается рамкой, а не превращается в полоску', () => {
  const f = imageFrame(1080, 9000);
  assert.strictEqual(f.height, 280);
  assert.strictEqual(f.width, 120);
  assert.strictEqual(f.cropped, true);
});

test('без размеров — рамка по умолчанию', () => {
  assert.deepStrictEqual(imageFrame(undefined, undefined), { width: 360, height: 225, cropped: false });
});
