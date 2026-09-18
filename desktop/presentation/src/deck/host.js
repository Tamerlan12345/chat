// Связь дека с окнами приложения: принимает их запросы и отдает подставному
// серверу, а также умеет посылать окнам команды сценария.
import appJs from '../../dist-app/app.js?raw';
import appCss from '../../dist-app/app.css?raw';

const esc = (code) => String(code).replace(/<\/script/gi, '<\\/script');

export function frameSrcDoc(boot) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>OpenMyChat Enterprise</title>
<style>${appCss}</style></head><body><div id="root"></div>
<script>window.__OMC__=${JSON.stringify(boot).replace(/</g, '\\u003c')};<\/script>
<script type="module">${esc(appJs)}<\/script></body></html>`;
}

export function createHost(server) {
  const frames = new Map(); // window -> record
  let seq = 1;
  const waiting = new Map();

  function register(win, record) {
    frames.set(win, record);
  }
  function unregister(win) {
    const rec = frames.get(win);
    if (rec) {
      for (const sock of rec.sockets.values()) sock.close();
      frames.delete(win);
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.__omc) return;
    const rec = frames.get(e.source);
    if (!rec) return;
    const reply = (payload) => e.source.postMessage({ __omc: true, ...payload }, '*');

    switch (m.t) {
      case 'ready':
        rec.onReady?.();
        return;
      case 'http': {
        const res = server.http({ method: m.method, path: m.path, body: m.body, token: m.token });
        setTimeout(() => reply({ t: 'http:res', id: m.id, res }), rec.latency ?? 90);
        return;
      }
      case 'upload': {
        const res = server.upload(m);
        setTimeout(() => reply({ t: 'upload:res', id: m.id, res }), 120);
        return;
      }
      case 'ws:open': {
        const sock = server.connect(rec.id + ':' + m.cid, (data) => reply({ t: 'ws:msg', cid: m.cid, data }));
        rec.sockets.set(m.cid, sock);
        return;
      }
      case 'ws:send': {
        rec.sockets.get(m.cid)?.message(m.data);
        return;
      }
      case 'ws:close': {
        rec.sockets.get(m.cid)?.close();
        rec.sockets.delete(m.cid);
        return;
      }
      case 'report': {
        const resolve = waiting.get(m.id);
        if (resolve) {
          waiting.delete(m.id);
          resolve(m);
        }
        return;
      }
      default:
    }
  });

  function command(win, cmd, timeout = 12000) {
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('окно не ответило: ' + (cmd.do || '')));
      }, timeout);
      waiting.set(id, (res) => {
        clearTimeout(timer);
        if (res.ok) resolve(res);
        else reject(new Error(res.error || 'ошибка команды'));
      });
      win.postMessage({ __omc: true, t: 'cmd', id, cmd }, '*');
    });
  }

  return { register, unregister, command, frames };
}
