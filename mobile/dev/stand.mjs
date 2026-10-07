// One-command local HTTPS stand: CentyChat server (HTTP, loopback only) + TLS
// proxy + seed data.
//
//   node mobile/dev/stand.mjs      (settings: mobile/dev/dev.env)
//
// Also importable: startStand({...}) is what the integration test uses.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTlsProxy } from './tls-proxy.mjs';
import { seed, CREDENTIALS } from './seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

// Port 2004 belongs to the owner's own local CentyChat server: the stand never
// starts on it, never proxies it and never seeds it.
export const RESERVED_PORTS = Object.freeze([2004]);
export const DEFAULT_SERVER_PORT = 2014;

export function assertNotReservedPort(port) {
  if (RESERVED_PORTS.includes(Number(port))) {
    throw new Error(`Port ${port} is reserved for the owner's local server; the dev stand does not use it. Pick another SERVER_PORT (default ${DEFAULT_SERVER_PORT}).`);
  }
}

// Settings that point a server at real infrastructure or real secrets. The
// stand's server must never inherit them from the developer's shell (for
// example under `railway run`): it would open the production database, send
// real mail or push, and seed.mjs would create dev users there.
const STRIPPED_PREFIXES = ['DATABASE_', 'POSTGRES', 'PG', 'SMTP_', 'PUSH_', 'FCM_', 'APNS_', 'RAILWAY_', 'BACKUP_', 'REGISTRATION_', 'ADMIN_PASSWORD_RESET', 'TELEGRAM_'];
const STRIPPED_NAMES = new Set([
  'JWT_SECRET', 'AUDIT_HMAC_KEY', 'NODE_ENV', 'DATA_DIR', 'UPDATES_DIR', 'INITIAL_ADMIN_NAME', 'INITIAL_ADMIN_PASSWORD',
  'ALLOWED_CLIENT_IPS', 'CORS_ALLOWED_ORIGINS', 'IDENTITY_AUTO_IMPORT', 'IDENTITY_ALLOW_EMPTY_BOOTSTRAP', 'HTTPS_TERMINATED',
  'TRUSTED_PROXY_IPS', 'GOOGLE_APPLICATION_CREDENTIALS'
]);

/** The inherited environment minus production-relevant settings. */
export function standServerEnv(base = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (STRIPPED_NAMES.has(upper) || STRIPPED_PREFIXES.some((p) => upper.startsWith(p))) continue;
    out[name] = value;
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => reject(new Error(`Port ${port} is already in use (${e.code}). Stop the other process or set SERVER_PORT in mobile/dev/dev.env.`)));
    s.listen(port, '127.0.0.1', () => s.close(resolve));
  });
}

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

function ensureCerts(certDir) {
  if (fs.existsSync(path.join(certDir, 'dev-leaf.key')) && fs.existsSync(path.join(certDir, 'dev-chain.crt'))) return;
  const r = spawnSync('bash', [path.join(HERE, 'make-dev-ca.sh'), certDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('make-dev-ca.sh failed (is openssl installed?)');
}

async function waitForHealth(port, child, getLog) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${getLog()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy:\n${getLog()}`);
}

/**
 * Starts the real CentyChat server as a child process on 127.0.0.1 with its own
 * data dir (no TLS, no seeding). Shared by the stand and the fixture capture.
 * port 0 = pick a random free port.
 */
export async function startServerProcess({ dataDir, port = 0, quiet = false, env = {} } = {}) {
  assertNotReservedPort(port);
  fs.mkdirSync(dataDir, { recursive: true });
  const listenPort = port || await freePort();
  if (port) await assertPortFree(listenPort);

  let log = '';
  const child = spawn(process.execPath, [path.join(REPO, 'server/src/index.js')], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...standServerEnv(process.env),
      // Explicit settings from the caller (tests, fixture capture) still apply.
      ...env,
      PORT: String(listenPort),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      INITIAL_ADMIN_PASSWORD: CREDENTIALS.adminInitial,
      TRUSTED_PROXY_IPS: '127.0.0.1,::1,::ffff:127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const onData = (chunk) => { log = (log + chunk).slice(-8000); if (!quiet) process.stdout.write(chunk); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const close = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  };
  try {
    await waitForHealth(listenPort, child, () => log);
  } catch (err) {
    await close();
    throw err;
  }
  return { port: listenPort, close, getLog: () => log };
}

/**
 * @param {{dataDir?: string, certDir?: string, tlsPort?: number, serverPort?: number, quiet?: boolean}} opts
 *   serverPort/tlsPort 0 = pick a random free port.
 */
export async function startStand({
  dataDir = path.join(HERE, 'data'),
  certDir = path.join(HERE, 'certs'),
  tlsPort = 8443,
  serverPort = DEFAULT_SERVER_PORT,
  quiet = false,
  env = {},
  tlsHost = '127.0.0.1'
} = {}) {
  assertNotReservedPort(serverPort);
  ensureCerts(certDir);
  const server = await startServerProcess({ dataDir, port: serverPort, quiet, env });

  let proxy;
  const close = async () => {
    await proxy?.close();
    await server.close();
  };

  try {
    const seeded = await seed({ baseUrl: `http://127.0.0.1:${server.port}` });
    proxy = await startTlsProxy({
      key: fs.readFileSync(path.join(certDir, 'dev-leaf.key')),
      cert: fs.readFileSync(path.join(certDir, 'dev-chain.crt')),
      listenPort: tlsPort,
      listenHost: tlsHost,
      targetPort: server.port
    });
    return { serverPort: server.port, tlsPort: proxy.port, seed: seeded, caCert: path.join(certDir, 'dev-ca.crt'), close };
  } catch (err) {
    await close();
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = { ...loadEnvFile(path.join(HERE, 'dev.env')), ...process.env };
  const stand = await startStand({
    dataDir: cfg.DEV_DATA_DIR ? path.resolve(cfg.DEV_DATA_DIR) : path.join(HERE, 'data'),
    tlsPort: Number(cfg.TLS_PORT || 8443),
    tlsHost: cfg.TLS_LISTEN_HOST || '127.0.0.1',
    serverPort: Number(cfg.SERVER_PORT || DEFAULT_SERVER_PORT)
  });
  console.log(`
CentyChat dev stand is up
  HTTPS/WSS : https://localhost:${stand.tlsPort}   (emulator: https://10.0.2.2:${stand.tlsPort}; loopback only, TLS_LISTEN_HOST=0.0.0.0 for devices on the LAN)
  HTTP (loopback only): http://127.0.0.1:${stand.serverPort}
  Dev CA    : ${stand.caCert}
  Users     : alice / ${CREDENTIALS.alice.password}
              bob   / ${CREDENTIALS.bob.password}
  Ctrl+C to stop.`);
  const stop = async () => { await stand.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
