import test from 'node:test';
import assert from 'node:assert';
import { themeForDate } from '../src/renderer/src/lib/theme.mjs';

const at = (h, m = 0) => new Date(2026, 8, 14, h, m, 0, 0);

test('с 6:00 до 15:00 — светлая тема', () => {
  assert.strictEqual(themeForDate(at(6)), 'light');
  assert.strictEqual(themeForDate(at(10, 30)), 'light');
  assert.strictEqual(themeForDate(at(14, 59)), 'light');
});

test('с 15:00 до 6:00 — тёмная тема', () => {
  assert.strictEqual(themeForDate(at(15)), 'dark');
  assert.strictEqual(themeForDate(at(23, 59)), 'dark');
  assert.strictEqual(themeForDate(at(0)), 'dark');
  assert.strictEqual(themeForDate(at(5, 59)), 'dark');
});
