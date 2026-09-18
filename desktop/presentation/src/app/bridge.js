// Мост между окном приложения и подставным сервером, который живет в деке.
// Приложение работает своим обычным кодом: fetch, WebSocket, XHR для загрузки
// файлов. Здесь они перенаправляются в родительское окно через postMessage.

const pending = new Map();
let seq = 1;
const sockets = new Map();
let frameId = 'frame-' + Math.random().toString(36).slice(2, 8);

export const bus = {
  onScene: null, // (payload) => void
  onCommand: null
};

function send(payload) {
  window.parent.postMessage({ __omc: true, from: frameId, ...payload }, '*');
}

function rpc(kind, data) {
  const id = seq++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ t: kind, id, ...data });
  });
}

// ── Память вместо localStorage: в срдоке хранилище может быть недоступно ──
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(String(k)),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; }
  };
}

export function installStorage(seed) {
  const store = memoryStorage(seed);
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      Object.defineProperty(window, name, { configurable: true, get: () => store });
    } catch {
      // Если переопределить нельзя — пишем в настоящее хранилище.
      try { for (const [k, v] of Object.entries(seed || {})) window[name].setItem(k, v); } catch {}
    }
  }
}

// ── fetch ────────────────────────────────────────────────────────────────────
export function installFetch() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/')) return realFetch(input, options);
    const token = String(options.headers?.Authorization || options.headers?.authorization || '').replace('Bearer ', '');
    let body = options.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const res = await rpc('http', { method: (options.method || 'GET').toUpperCase(), path: url, body, token });
    if (res.file) {
      const bin = atob(res.file.base64 || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { status: 200, headers: { 'Content-Type': res.file.type, 'Content-Disposition': res.file.disposition || '' } });
    }
    return new Response(JSON.stringify(res.data ?? null), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' }
    });
  };
}

// ── Загрузка файла (XMLHttpRequest c прогрессом) ─────────────────────────────
export function installUpload() {
  const RealXHR = window.XMLHttpRequest;
  class UploadXHR {
    constructor() {
      this.upload = {};
      this.readyState = 0;
      this.status = 0;
      this.responseText = '';
      this._headers = {};
      this._aborted = false;
    }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    abort() {
      this._aborted = true;
      clearInterval(this._timer);
      this.onabort?.();
    }
    async send(formData) {
      if (!String(this._url).includes('/api/files/upload')) {
        const real = new RealXHR();
        real.open(this._method, this._url);
        for (const [k, v] of Object.entries(this._headers)) real.setRequestHeader(k, v);
        real.onload = () => { this.status = real.status; this.responseText = real.responseText; this.onload?.(); };
        real.onerror = () => this.onerror?.();
        real.send(formData);
        return;
      }
      const file = formData.get('file');
      const token = String(this._headers.Authorization || '').replace('Bearer ', '');
      const total = file.size;
      // Крупный файл читаем не целиком: для показа хватит типа и размера.
      let dataUrl = null;
      if (file.size <= 8 * 1024 * 1024) {
        dataUrl = await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(file);
        });
      }
      if (this._aborted) return;
      // Прогресс: около трех секунд, как на обычной офисной сети.
      const started = Date.now();
      const duration = Math.min(4200, Math.max(1200, total / 40000));
      this._timer = setInterval(() => {
        const ratio = Math.min(1, (Date.now() - started) / duration);
        this.upload.onprogress?.({ lengthComputable: true, loaded: Math.round(total * ratio), total });
        if (ratio >= 1) {
          clearInterval(this._timer);
          rpc('upload', { token, name: file.name, mime: file.type, size: file.size, dataUrl }).then((res) => {
            if (this._aborted) return;
            this.status = res.status;
            this.responseText = JSON.stringify(res.data ?? {});
            this.onload?.();
          });
        }
      }, 90);
    }
  }
  window.XMLHttpRequest = UploadXHR;
}

// ── WebSocket ────────────────────────────────────────────────────────────────
export function installWebSocket() {
  const RealWS = window.WebSocket;
  let cid = 1;
  class MockWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      if (!String(url).includes('/ws')) return new RealWS(url);
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this._id = 'ws' + cid++;
      sockets.set(this._id, this);
      send({ t: 'ws:open', cid: this._id });
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
      }, 60);
    }
    send(data) {
      if (this.readyState !== 1) return;
      if (typeof data !== 'string') return; // звук в презентации не передаем
      send({ t: 'ws:send', cid: this._id, data });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      send({ t: 'ws:close', cid: this._id });
      sockets.delete(this._id);
      this.onclose?.({ type: 'close' });
    }
    addEventListener(type, fn) { this['on' + type] = fn; }
    removeEventListener(type) { this['on' + type] = null; }
  }
  MockWebSocket.prototype.CONNECTING = 0;
  MockWebSocket.prototype.OPEN = 1;
  MockWebSocket.prototype.CLOSED = 3;
  window.WebSocket = MockWebSocket;
}

// ── Микрофон: беззвучная дорожка, чтобы звонок в презентации шел без запроса ──
export function installMedia() {
  const fake = async () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dst = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(dst);
    osc.start();
    return dst.stream;
  };
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
  }
  navigator.mediaDevices.getUserMedia = fake;
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || !m.__omc) return;
  if (m.t === 'http:res' || m.t === 'upload:res') {
    const resolve = pending.get(m.id);
    if (resolve) { pending.delete(m.id); resolve(m.res); }
    return;
  }
  if (m.t === 'ws:msg') {
    const ws = sockets.get(m.cid);
    if (ws && ws.readyState === 1) ws.onmessage?.({ data: JSON.stringify(m.data) });
    return;
  }
  if (m.t === 'scene') { bus.onScene?.(m); return; }
  if (m.t === 'cmd') { bus.onCommand?.(m); return; }
  if (m.t === 'id') { frameId = m.frameId; }
});

export function ready(role) {
  send({ t: 'ready', role });
}
export function report(payload) {
  send({ t: 'report', ...payload });
}
