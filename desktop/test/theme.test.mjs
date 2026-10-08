import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { themeForDate } from '../src/renderer/src/lib/theme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '../src/renderer/src');

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

test('login markup and light/dark responsive CSS layout contracts remain valid', async () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.window = {
    location: { protocol: 'https:', hostname: 'login.test', origin: 'https://login.test' }
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };

  let vite;
  try {
    vite = await createServer({
      configFile: path.resolve(here, '../vite.config.js'),
      root: path.resolve(here, '..'),
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, entries: [] },
      server: { middlewareMode: true }
    });
    const { default: LoginView } = await vite.ssrLoadModule('/src/renderer/src/components/LoginView.jsx');
    const css = fs.readFileSync(path.join(rendererRoot, 'styles/theme.css'), 'utf8');
    const layouts = ['light', 'dark'].map((theme) => {
      const markup = renderToStaticMarkup(
        React.createElement('html', { 'data-theme': theme },
          React.createElement('body', null,
            React.createElement(LoginView, { onLoginSuccess: () => {}, initialServerUrl: 'https://login.test' })
          )
        )
      );

      assert.match(markup, new RegExp(`<html data-theme="${theme}">`));
      assert.match(markup, /class="login-container"/);
      assert.match(markup, /class="login-card login-card--split"/);
      assert.match(markup, /<aside class="login-brand">/);
      assert.match(markup, /class="login-main"/);
      assert.match(markup, /<h1 class="login-title">Вход в CentyChat<\/h1>/);
      assert.match(markup, /<form class="login-form">/);
      assert.match(markup, /id="login-username"/);
      assert.match(markup, /id="login-password"/);
      assert.doesNotMatch(markup, /company_name|Корпоративный мессенджер/);
      return markup
        .replace(/data-theme="(?:light|dark)"/, 'data-theme="theme"')
        .replace(/_R_[A-Za-z0-9_]+/g, '_R_ID_');
    });

    assert.equal(layouts[0], layouts[1], 'both themes must render the same login structure and controls');
    assert.match(css, /:root\s*\{\s*color-scheme:\s*dark;/);
    assert.match(css, /:root\[data-theme='light'\]\s*\{\s*color-scheme:\s*light;/);
    assert.match(css, /--bg-elevated:\s*light-dark\(/);
    assert.match(css, /--text-strong:\s*light-dark\(/);
    assert.match(css, /\.login-container\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*safe center;[^}]*overflow:\s*auto;/s);
    assert.match(css, /\.login-card--split\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(300px,\s*5fr\)\s+6fr;/s);
    assert.match(css, /@media\s*\(max-width:\s*820px\)\s*\{\s*\.login-card--split\s*\{\s*grid-template-columns:\s*1fr;[^}]*\}\s*\.login-brand\s*\{\s*display:\s*none;/);
  } finally {
    await vite?.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});
