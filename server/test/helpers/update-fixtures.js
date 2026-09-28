const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Общие заготовки для тестов автообновления: «установщик» — это MZ и
// случайный заполнитель, latest.yml строится тестом так же, как его пишет
// electron-builder. Настоящая сборка для проверки хранилища не нужна — важны
// имена, размеры и sha512.

function sha512(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

function buildFixture(version, { exe, withBlockmap = true, withPortable = false, releaseDate = '2026-09-28T10:00:00.000Z' } = {}) {
  const setupName = `OpenMyChat-Enterprise-Setup-${version}.exe`;
  const setup = exe || Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4096)]);
  const hash = sha512(setup);
  const fixture = {
    version,
    setupName,
    setup,
    sha512: hash,
    blockmapName: `${setupName}.blockmap`,
    blockmap: withBlockmap ? Buffer.from(`blockmap ${version}`) : null,
    portableName: `OpenMyChat-Enterprise-Portable-${version}.exe`,
    portable: withPortable ? Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(1024)]) : null
  };
  fixture.yml = renderFixtureYml({
    version,
    url: setupName,
    sha512: hash,
    size: setup.length,
    path: setupName,
    releaseDate
  });
  return fixture;
}

function renderFixtureYml({ version, url, sha512: hash, size, path: p, topSha512, releaseDate, extra = '' }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${hash}`,
    `    size: ${size}`,
    `path: ${p}`,
    `sha512: ${topSha512 || hash}`,
    `releaseDate: '${releaseDate}'`,
    extra
  ].join('\n');
}

// Раскладывает заготовку папкой, как её кладёт publish-update.ps1.
function writeReleaseDir(dir, fixture, { yml, setupName } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml ?? fixture.yml);
  fs.writeFileSync(path.join(dir, setupName || fixture.setupName), fixture.setup);
  if (fixture.blockmap) fs.writeFileSync(path.join(dir, fixture.blockmapName), fixture.blockmap);
  if (fixture.portable) fs.writeFileSync(path.join(dir, fixture.portableName), fixture.portable);
  fs.writeFileSync(path.join(dir, 'README.txt'), 'не относится к релизу');
  return dir;
}

function tempDir(prefix = 'omc-updates-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { sha512, buildFixture, renderFixtureYml, writeReleaseDir, tempDir };
