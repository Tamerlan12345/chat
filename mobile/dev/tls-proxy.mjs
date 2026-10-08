// Zero-dependency HTTPS + WSS reverse proxy for the local mobile dev stand.
// Terminates TLS and forwards plain HTTP/WebSocket to the CentyChat server,
// adding X-Forwarded-Proto: https (the server treats that as "behind HTTPS").
//
//   node mobile/dev/tls-proxy.mjs     (env: TLS_PORT, SERVER_PORT, TLS_CERT_DIR, TLS_LISTEN_HOST)
//
// Listens on 127.0.0.1 by default: the Android emulator reaches it as 10.0.2.2
// (the host's loopback) and the iOS simulator as localhost. Anyone on the LAN
// could otherwise use the stand with its documented seed passwords; set
// TLS_LISTEN_HOST=0.0.0.0 only to test from a physical device.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function forwardedHeaders(req, listenHost) {
  return {
    'x-forwarded-proto': 'https',
    'x-forwarded-for': req.socket.remoteAddress || '',
    'x-forwarded-host': req.headers.host || listenHost
  };
}

/**
 * @param {{key: Buffer|string, cert: Buffer|string, listenPort?: number, listenHost?: string,
 *          targetHost?: string, targetPort: number}} opts
 * @returns {Promise<{server: https.Server, port: number, close: () => Promise<void>}>}
 */
export function startTlsProxy({ key, cert, listenPort = 8443, listenHost = '127.0.0.1', targetHost = '127.0.0.1', targetPort }) {
  const sockets = new Set();

  const server = https.createServer({ key, cert }, (req, res) => {
    // Client-supplied X-Forwarded-* are discarded, ours are authoritative.
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!name.startsWith('x-forwarded-')) headers[name] = value;
    }
    Object.assign(headers, forwardedHeaders(req, listenHost));
    const upstream = http.request({ host: targetHost, port: targetPort, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode, up.statusMessage, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad gateway');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  // WebSocket (any Upgrade): re-send the request head upstream, then pipe both
  // directions raw. No framing knowledge needed.
  server.on('upgrade', (req, clientSocket, head) => {
    const upstream = net.connect(targetPort, targetHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase().startsWith('x-forwarded-')) continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      for (const [name, value] of Object.entries(forwardedHeaders(req, listenHost))) lines.push(`${name}: ${value}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    const teardown = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', teardown);
    clientSocket.on('error', teardown);
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        })
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const certDir = process.env.TLS_CERT_DIR || path.join(here, 'certs');
  const targetPort = Number(process.env.SERVER_PORT || 2014);
  // 2004 is the owner's own local server: never publish it through the proxy.
  if (targetPort === 2004) {
    console.error('[tls-proxy] SERVER_PORT=2004 is reserved for the owner\'s local server; refusing to proxy it.');
    process.exit(2);
  }
  const listenHost = process.env.TLS_LISTEN_HOST || '127.0.0.1';
  const proxy = await startTlsProxy({
    key: fs.readFileSync(path.join(certDir, 'dev-leaf.key')),
    cert: fs.readFileSync(path.join(certDir, 'dev-chain.crt')),
    listenPort: Number(process.env.TLS_PORT || 8443),
    listenHost,
    targetPort
  });
  console.log(`[tls-proxy] https/wss on ${listenHost}:${proxy.port} -> http://127.0.0.1:${targetPort}`);
}
