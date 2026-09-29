const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isValidVersion, compareVersions } = require('./update-policy.service');

// Хранилище релизов настольного клиента:
//
//   <UPDATES_DIR>/releases/<версия>/{Setup.exe, .blockmap, Portable.exe?, release.json}
//   <UPDATES_DIR>/inbox/<папка>/     — сюда администратор кладёт выпуск руками
//   <UPDATES_DIR>/.tmp/              — загрузки и сборка релиза до переноса
//
// Единственный путь файла в раздачу — проверка (строгий latest.yml, имена по
// шаблону версии, MZ, размер, sha512) и атомарный перенос готовой папки.
// Раздаются файлы только по индексу «имя → путь», собранному из release.json:
// путь к файлу никогда не строится из того, что прислал клиент.

const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_INBOX = /^[0-9A-Za-z._-]{1,64}$/;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;
const YML_MAX_BYTES = 64 * 1024;
const NOTES_MAX = 2000;

const TOP_KEYS = new Set(['version', 'files', 'path', 'sha512', 'releaseDate', 'releaseNotes']);
const FILE_KEYS = new Set(['url', 'sha512', 'size', 'blockMapSize']);
const INT_KEYS = new Set(['size', 'blockMapSize']);

class UpdateStoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const setupNameOf = (version) => `CentyChat-Setup-${version}.exe`;
const portableNameOf = (version) => `CentyChat-Portable-${version}.exe`;
const clip = (s, n = 64) => String(s).slice(0, n);

// ── latest.yml ─────────────────────────────────────────────────────────────
// Своего разбора хватает: формат electron-builder фиксирован, а
// универсальный YAML-парсер (якоря, теги, вложенность) — лишняя поверхность
// атаки на файле, пришедшем из загрузки. Всё, что не похоже на ожидаемую
// форму, отвергается.

function ymlError(message) {
  return new UpdateStoreError(`latest.yml: ${message}`, 400);
}

function parseScalar(raw, lineNo) {
  const text = raw.replace(/ +$/, '');
  if (!text) throw ymlError(`пустое значение в строке ${lineNo}`);
  if (text[0] === "'") {
    const m = /^'((?:[^']|'')*)'$/.exec(text);
    if (!m) throw ymlError(`незакрытая кавычка в строке ${lineNo}`);
    return { value: m[1].replace(/''/g, "'"), quoted: true };
  }
  if (text[0] === '"') {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw ymlError(`неверная строка в кавычках в строке ${lineNo}`);
    }
    if (typeof value !== 'string') throw ymlError(`неверная строка в кавычках в строке ${lineNo}`);
    return { value, quoted: true };
  }
  // Простое значение: никаких якорей, ссылок, тегов, блоков и поточных форм.
  if (/^[-?:,[\]{}#&*!|>%@`]/.test(text) || /: | #/.test(text)) {
    throw ymlError(`неожиданное значение в строке ${lineNo}`);
  }
  return { value: text, quoted: false };
}

function assignKey(target, allowed, key, raw, lineNo) {
  if (!allowed.has(key)) throw ymlError(`неизвестный ключ «${clip(key)}» в строке ${lineNo}`);
  if (Object.hasOwn(target, key)) throw ymlError(`повтор ключа «${key}» в строке ${lineNo}`);
  if (raw === undefined) throw ymlError(`у ключа «${key}» нет значения (строка ${lineNo})`);
  const { value, quoted } = parseScalar(raw, lineNo);
  if (INT_KEYS.has(key)) {
    if (quoted || !/^\d{1,15}$/.test(value)) throw ymlError(`${key} должен быть целым числом (строка ${lineNo})`);
    target[key] = Number(value);
  } else {
    target[key] = value;
  }
}

/**
 * Строгий разбор latest.yml. Возвращает
 * { version, files:[{url, sha512, size, blockMapSize?}], path, sha512, releaseDate, releaseNotes? }.
 */
function readYml(text) {
  if (typeof text !== 'string' || !text.trim()) throw ymlError('файл пуст');
  if (Buffer.byteLength(text, 'utf8') > YML_MAX_BYTES) throw ymlError('файл слишком большой');
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');

  const out = {};
  let inFiles = false;
  let current = null;
  let itemIndent = null;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (!line.trim()) return;
    if (/[\t\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) throw ymlError(`недопустимый символ в строке ${lineNo}`);
    const indent = line.length - line.replace(/^ +/, '').length;

    if (indent === 0) {
      const m = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
      if (!m) throw ymlError(`неожиданная строка ${lineNo}`);
      const [, key, raw] = m;
      if (key === 'files') {
        if (Object.hasOwn(out, 'files')) throw ymlError(`повтор ключа «files» в строке ${lineNo}`);
        if (raw !== undefined && raw.trim() !== '') throw ymlError(`files должен быть списком (строка ${lineNo})`);
        out.files = [];
        inFiles = true;
        current = null;
        itemIndent = null;
        return;
      }
      inFiles = false;
      assignKey(out, TOP_KEYS, key, raw, lineNo);
      return;
    }

    if (!inFiles) throw ymlError(`неожиданный отступ в строке ${lineNo}`);
    const item = /^( +)- ([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
    if (item) {
      if (itemIndent === null) itemIndent = item[1].length;
      else if (item[1].length !== itemIndent) throw ymlError(`неверный отступ в строке ${lineNo}`);
      current = {};
      out.files.push(current);
      assignKey(current, FILE_KEYS, item[2], item[3], lineNo);
      return;
    }
    const cont = /^( +)([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
    if (cont && current && cont[1].length === itemIndent + 2) {
      assignKey(current, FILE_KEYS, cont[2], cont[3], lineNo);
      return;
    }
    throw ymlError(`неожиданная строка ${lineNo}`);
  });

  for (const key of ['version', 'path', 'sha512', 'releaseDate']) {
    if (typeof out[key] !== 'string' || !out[key]) throw ymlError(`нет поля ${key}`);
  }
  if (!Array.isArray(out.files) || out.files.length === 0) throw ymlError('нет списка files');
  if (out.files.length > 4) throw ymlError('слишком много файлов в files');
  for (const f of out.files) {
    if (typeof f.url !== 'string' || typeof f.sha512 !== 'string' || !Number.isSafeInteger(f.size)) {
      throw ymlError('у элемента files должны быть url, sha512 и size');
    }
  }
  return out;
}

// Строки — в двойных кавычках с экранированием JSON: это подмножество YAML,
// и ни двоеточие, ни решётка, ни перевод строки в заметках не ломают разметку.
function yamlString(s) {
  return JSON.stringify(String(s)).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function renderYml(feed) {
  const lines = [`version: ${yamlString(feed.version)}`, 'files:'];
  for (const f of feed.files) {
    lines.push(`  - url: ${yamlString(f.url)}`);
    lines.push(`    sha512: ${yamlString(f.sha512)}`);
    lines.push(`    size: ${Number(f.size)}`);
    if (f.blockMapSize !== undefined) lines.push(`    blockMapSize: ${Number(f.blockMapSize)}`);
  }
  lines.push(`path: ${yamlString(feed.path)}`);
  lines.push(`sha512: ${yamlString(feed.sha512)}`);
  lines.push(`releaseDate: ${yamlString(feed.releaseDate)}`);
  if (feed.releaseNotes !== undefined && feed.releaseNotes !== null) {
    lines.push(`releaseNotes: ${yamlString(feed.releaseNotes)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Лента для electron-updater строится из release.json, а не из загруженного
 * текста: в раздачу попадает только то, что сервер сам проверил.
 */
function feedOf(release) {
  const setup = release.files.find((f) => f.kind === 'setup');
  const entry = { url: setup.name, sha512: setup.sha512, size: setup.size };
  if (release.blockMapSize !== undefined) entry.blockMapSize = release.blockMapSize;
  const feed = {
    version: release.version,
    files: [entry],
    path: setup.name,
    sha512: setup.sha512,
    releaseDate: release.releaseDate
  };
  if (release.notes) feed.releaseNotes = release.notes;
  return feed;
}

function cleanNotes(notes) {
  if (notes === undefined || notes === null) return '';
  if (typeof notes !== 'string') throw new UpdateStoreError('Заметки к выпуску должны быть текстом');
  const text = notes.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (text.length > NOTES_MAX) throw new UpdateStoreError(`Заметки к выпуску — не длиннее ${NOTES_MAX} символов`);
  return text;
}

async function sha512File(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

async function readHeader(file, n) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function summaryOf(release) {
  const setup = release.files.find((f) => f.kind === 'setup');
  return {
    version: release.version,
    releaseDate: release.releaseDate,
    sha512: setup?.sha512 ?? null,
    size: setup?.size ?? null,
    files: release.files.map(({ name, size, sha512 }) => ({ name, size, sha512 })),
    importedAt: release.importedAt,
    importedBy: release.importedBy,
    notes: release.notes
  };
}

function createUpdateStore({ dir, maxFileBytes }) {
  const root = path.resolve(dir);
  const RELEASES = path.join(root, 'releases');
  const INBOX = path.join(root, 'inbox');
  const TMP = path.join(root, '.tmp');

  let releases = new Map(); // версия → release.json
  let index = new Map(); // имя файла → абсолютный путь
  let inited = false;
  // Импорт и удаление идут строго по очереди: проверка «такой версии ещё
  // нет» и перенос папки не должны перемежаться с чужими.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };

  function init() {
    for (const d of [root, RELEASES, INBOX, TMP]) fs.mkdirSync(d, { recursive: true });
    // Хвосты прерванных загрузок и импортов прошлого запуска.
    for (const entry of fs.readdirSync(TMP)) {
      fs.rmSync(path.join(TMP, entry), { recursive: true, force: true });
    }
    rebuild();
    inited = true;
  }

  function ensure() {
    if (!inited) init();
  }

  function rebuild() {
    const nextReleases = new Map();
    const nextIndex = new Map();
    for (const entry of fs.readdirSync(RELEASES, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidVersion(entry.name)) continue;
      let rel;
      try {
        rel = JSON.parse(fs.readFileSync(path.join(RELEASES, entry.name, 'release.json'), 'utf8'));
      } catch (err) {
        console.warn(`[Updates] релиз ${entry.name} пропущен: release.json не читается (${err.message})`);
        continue;
      }
      if (!rel || rel.version !== entry.name || !Array.isArray(rel.files)) continue;
      const files = rel.files.filter((f) => f && typeof f.name === 'string' && SAFE_FILE.test(f.name));
      if (!files.some((f) => f.kind === 'setup')) continue;
      for (const f of files) {
        const abs = path.join(RELEASES, entry.name, f.name);
        if (abs.startsWith(RELEASES + path.sep)) nextIndex.set(f.name, abs);
      }
      nextReleases.set(rel.version, { ...rel, files });
    }
    releases = nextReleases;
    index = nextIndex;
  }

  function listReleases() {
    ensure();
    return [...releases.values()]
      .sort((a, b) => compareVersions(b.version, a.version))
      .map(summaryOf);
  }

  function getRelease(version) {
    ensure();
    return releases.get(version) || null;
  }

  function resolveFile(name) {
    ensure();
    if (typeof name !== 'string' || !SAFE_FILE.test(name)) return null;
    const abs = index.get(name);
    if (!abs || !abs.startsWith(RELEASES + path.sep)) return null;
    return abs;
  }

  function createTempDir() {
    ensure();
    return fs.mkdtempSync(path.join(TMP, 'up-'));
  }

  // Общая проверка для загрузки и inbox. sourcesFor(version) называет
  // исходные файлы уже по каноническим именам этой версии.
  async function commit({ ymlText, sourcesFor, move, actor, notes }) {
    const feed = readYml(ymlText);
    const { version } = feed;
    if (!isValidVersion(version)) throw new UpdateStoreError(`Неверная версия в latest.yml: ${clip(version)}`);
    if (releases.has(version) || fs.existsSync(path.join(RELEASES, version))) {
      throw new UpdateStoreError(`Версия ${version} уже загружена`, 409);
    }

    const setupName = setupNameOf(version);
    if (feed.files.length !== 1) throw new UpdateStoreError('В latest.yml должен быть ровно один файл — установщик');
    const [entry] = feed.files;
    for (const name of [entry.url, feed.path]) {
      if (!SAFE_FILE.test(name) || name !== setupName) {
        throw new UpdateStoreError(`Имя установщика в latest.yml должно быть ${setupName}`);
      }
    }
    if (entry.sha512 !== feed.sha512 || !SHA512_B64.test(entry.sha512)) {
      throw new UpdateStoreError('sha512 в latest.yml неверен или не согласован');
    }
    if (feed.releaseDate.length > 64 || Number.isNaN(Date.parse(feed.releaseDate))) {
      throw new UpdateStoreError('Неверная releaseDate в latest.yml');
    }
    const cleanedNotes = cleanNotes(notes);
    const sources = sourcesFor(version);
    if (!sources.setup) throw new UpdateStoreError(`Не найден установщик ${setupName}`);

    const plan = [
      ['setup', setupName],
      ['blockmap', `${setupName}.blockmap`],
      ['portable', portableNameOf(version)]
    ];
    const limitMb = Math.round((maxFileBytes / 1024 / 1024) * 10) / 10;
    const staging = await fsp.mkdtemp(path.join(TMP, 'stage-'));
    try {
      const files = [];
      for (const [kind, name] of plan) {
        const src = sources[kind];
        if (!src) continue;
        let st;
        try {
          st = await fsp.lstat(src);
        } catch {
          throw new UpdateStoreError(`Не найден файл ${name}`);
        }
        if (!st.isFile()) throw new UpdateStoreError(`${name} — не обычный файл`);
        if (st.size > maxFileBytes) throw new UpdateStoreError(`Файл ${name} больше предела ${limitMb} МБ`);

        const dest = path.join(staging, name);
        if (move) await fsp.rename(src, dest);
        else await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);

        // Всё дальше — по скопированному файлу: подменить исходник между
        // проверкой и переносом уже нельзя.
        const size = (await fsp.stat(dest)).size;
        if (size > maxFileBytes) throw new UpdateStoreError(`Файл ${name} больше предела ${limitMb} МБ`);
        if (kind !== 'blockmap') {
          const head = await readHeader(dest, 2);
          if (head.toString('latin1') !== 'MZ') {
            throw new UpdateStoreError(`${name} — не исполняемый файл Windows (нет сигнатуры MZ)`);
          }
        }
        files.push({ name, kind, size, sha512: await sha512File(dest) });
      }

      const setup = files[0];
      if (setup.size !== entry.size) {
        throw new UpdateStoreError(`Размер установщика (${setup.size}) не совпадает с latest.yml (${entry.size})`);
      }
      if (setup.sha512 !== entry.sha512) {
        throw new UpdateStoreError('Файл переподписан после сборки — загрузите файл из desktop/release');
      }
      const blockmap = files.find((f) => f.kind === 'blockmap');
      if (blockmap && entry.blockMapSize !== undefined && blockmap.size !== entry.blockMapSize) {
        throw new UpdateStoreError('Размер blockmap не совпадает с latest.yml');
      }

      const release = {
        version,
        releaseDate: feed.releaseDate,
        files,
        importedAt: new Date().toISOString(),
        importedBy: actor?.username ?? null,
        importedById: actor?.id ?? null,
        notes: cleanedNotes
      };
      if (entry.blockMapSize !== undefined) release.blockMapSize = entry.blockMapSize;
      await fsp.writeFile(path.join(staging, 'release.json'), JSON.stringify(release, null, 2), { flag: 'wx' });

      const target = path.join(RELEASES, version);
      if (fs.existsSync(target)) throw new UpdateStoreError(`Версия ${version} уже загружена`, 409);
      try {
        await fsp.rename(staging, target);
      } catch (err) {
        if (fs.existsSync(target)) throw new UpdateStoreError(`Версия ${version} уже загружена`, 409);
        throw err;
      }
      rebuild();
      return summaryOf(release);
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async function readYmlFile(file) {
    let st;
    try {
      st = await fsp.lstat(file);
    } catch {
      throw new UpdateStoreError('Не найден latest.yml');
    }
    if (!st.isFile()) throw new UpdateStoreError('latest.yml — не обычный файл');
    if (st.size > YML_MAX_BYTES) throw ymlError('файл слишком большой');
    return fsp.readFile(file, 'utf8');
  }

  // Каталог inbox: только прямой потомок INBOX, без ссылок.
  async function resolveInboxDir(name) {
    ensure();
    if (typeof name !== 'string' || !SAFE_INBOX.test(name) || /^\.+$/.test(name)) {
      throw new UpdateStoreError('Недопустимое имя папки во входящих');
    }
    const resolved = path.resolve(INBOX, name);
    if (path.dirname(resolved) !== INBOX) throw new UpdateStoreError('Недопустимое имя папки во входящих');
    let st;
    try {
      st = await fsp.lstat(resolved);
    } catch {
      throw new UpdateStoreError('Папка не найдена во входящих', 404);
    }
    if (!st.isDirectory()) throw new UpdateStoreError('Во входящих это не папка');
    return resolved;
  }

  async function existingFile(file) {
    try {
      return (await fsp.lstat(file)).isFile() ? file : null;
    } catch {
      return null;
    }
  }

  function importFromDir(name, { actor = null, notes = '' } = {}) {
    return serial(async () => {
      const src = await resolveInboxDir(name);
      const ymlText = await readYmlFile(path.join(src, 'latest.yml'));
      // Необязательные файлы берутся, только если это обычные файлы с
      // каноническими именами — имена приходят из проверенной версии.
      const present = {};
      const probe = readYml(ymlText);
      if (isValidVersion(probe.version)) {
        const setupName = setupNameOf(probe.version);
        present.setup = await existingFile(path.join(src, setupName));
        present.blockmap = await existingFile(path.join(src, `${setupName}.blockmap`));
        present.portable = await existingFile(path.join(src, portableNameOf(probe.version)));
      }
      const summary = await commit({ ymlText, sourcesFor: () => present, move: false, actor, notes });
      await fsp.rm(src, { recursive: true, force: true }).catch((err) => {
        console.warn(`[Updates] папка inbox/${name} импортирована, но не удалена: ${err.message}`);
      });
      return summary;
    });
  }

  function importUpload(files, { actor = null, notes = '' } = {}) {
    return serial(async () => {
      ensure();
      const inTmp = (p) => typeof p === 'string' && path.resolve(p).startsWith(TMP + path.sep);
      for (const [key, p] of Object.entries(files || {})) {
        if (p !== undefined && p !== null && !inTmp(p)) throw new UpdateStoreError(`Файл ${key} не из временной папки загрузки`);
      }
      if (!files?.yml) throw new UpdateStoreError('Не передан latest.yml');
      const ymlText = await readYmlFile(path.resolve(files.yml));
      const sources = {
        setup: files.setup ? path.resolve(files.setup) : null,
        blockmap: files.blockmap ? path.resolve(files.blockmap) : null,
        portable: files.portable ? path.resolve(files.portable) : null
      };
      return commit({ ymlText, sourcesFor: () => sources, move: true, actor, notes });
    });
  }

  function deleteRelease(version, policy) {
    return serial(async () => {
      ensure();
      if (!isValidVersion(version)) throw new UpdateStoreError('Неверная версия');
      if (!releases.has(version)) throw new UpdateStoreError(`Версия ${version} не найдена`, 404);
      for (const [channel, cfg] of Object.entries(policy?.channels || {})) {
        if (cfg && cfg.target === version) {
          throw new UpdateStoreError(`Версия ${version} назначена каналу ${channel} — сначала смените target`, 409);
        }
      }
      // Сначала папка уходит из releases одним переносом, потом стирается:
      // полуудалённый релиз никогда не виден раздаче.
      const trash = path.join(TMP, `del-${crypto.randomBytes(6).toString('hex')}`);
      await fsp.rename(path.join(RELEASES, version), trash);
      rebuild();
      await fsp.rm(trash, { recursive: true, force: true }).catch(() => {});
    });
  }

  // Предварительная проверка для консоли: без хешей, чтобы открытие вкладки не
  // читало сотни мегабайт.
  function listInbox() {
    ensure();
    const out = [];
    for (const entry of fs.readdirSync(INBOX, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const item = { name, version: null, problems: [] };
      out.push(item);
      if (!SAFE_INBOX.test(name) || /^\.+$/.test(name)) {
        item.problems.push('Недопустимое имя папки: только латиница, цифры, точка, дефис и подчёркивание, до 64 символов');
        continue;
      }
      const dirPath = path.join(INBOX, name);
      let feed;
      try {
        const ymlPath = path.join(dirPath, 'latest.yml');
        const st = fs.lstatSync(ymlPath);
        if (!st.isFile() || st.size > YML_MAX_BYTES) throw new UpdateStoreError('latest.yml не читается');
        feed = readYml(fs.readFileSync(ymlPath, 'utf8'));
      } catch (err) {
        item.problems.push(err.code === 'ENOENT' ? 'Нет latest.yml' : err.message);
        continue;
      }
      if (!isValidVersion(feed.version)) {
        item.problems.push(`Неверная версия: ${clip(feed.version)}`);
        continue;
      }
      item.version = feed.version;
      if (releases.has(feed.version)) item.problems.push(`Версия ${feed.version} уже загружена`);
      const setupName = setupNameOf(feed.version);
      if (feed.files.length !== 1 || feed.files[0].url !== setupName || feed.path !== setupName) {
        item.problems.push(`Имя установщика в latest.yml должно быть ${setupName}`);
      }
      try {
        const st = fs.lstatSync(path.join(dirPath, setupName));
        if (!st.isFile()) item.problems.push(`${setupName} — не обычный файл`);
        else if (st.size !== feed.files[0].size) item.problems.push('Размер установщика не совпадает с latest.yml');
        else if (st.size > maxFileBytes) item.problems.push('Установщик больше допустимого размера');
      } catch {
        item.problems.push(`Нет файла ${setupName}`);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    root,
    releasesDir: RELEASES,
    inboxDir: INBOX,
    tmpDir: TMP,
    init,
    listReleases,
    getRelease,
    resolveFile,
    createTempDir,
    listInbox,
    importFromDir,
    importUpload,
    deleteRelease
  };
}

let defaultStore = null;

/** Хранилище по настройкам сервера; каталоги создаются при первом обращении. */
function getUpdateStore() {
  if (!defaultStore) {
    const config = require('../config');
    defaultStore = createUpdateStore({
      dir: config.UPDATES_DIR,
      maxFileBytes: config.UPDATES_MAX_FILE_MB * 1024 * 1024
    });
    defaultStore.init();
  }
  return defaultStore;
}

module.exports = {
  UpdateStoreError,
  createUpdateStore,
  getUpdateStore,
  readYml,
  renderYml,
  feedOf,
  setupNameOf,
  portableNameOf,
  SAFE_FILE
};
