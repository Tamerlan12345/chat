// Передача голоса через сервер по уже открытому WebSocket.
//
// Почему не WebRTC напрямую: в корпоративных сетях прямое соединение между
// двумя компьютерами почти всегда не устанавливается — исходящий UDP закрыт,
// NAT симметричный. Штатное лекарство от этого — TURN-сервер, но это отдельная
// служба, отдельные порты и отдельные расходы. Здесь звук идёт по тому же
// соединению, что и переписка, через 443 порт: если работает чат — работает и
// звонок, настраивать в сети нечего.
//
// Плата: трафик проходит через сервер. При 16 кГц моно это около 256 кбит/с в
// каждую сторону — для десятка одновременных разговоров несущественно.

const SAMPLE_RATE = 16000; // достаточно для речи; 8 кГц звучит телефонно
const FRAME_SAMPLES = 1024;

// Кадр: 4 байта — идентификатор собеседника, дальше 16-битные отсчёты.
function packFrame(peerId, samples) {
  const buffer = new ArrayBuffer(4 + samples.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, peerId, false);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(4 + i * 2, samples[i], false);
  }
  return buffer;
}

function unpackFrame(buffer) {
  const view = new DataView(buffer);
  const senderId = view.getUint32(0, false);
  const count = (buffer.byteLength - 4) / 2;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(4 + i * 2, false) / 32768;
  }
  return { senderId, samples };
}

export class AudioRelay {
  constructor({ ws, peerId, onLevel }) {
    this.ws = ws;
    this.peerId = peerId;
    this.onLevel = onLevel;
    this.muted = false;
    this.playAt = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.captureCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.playbackCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.playAt = this.playbackCtx.currentTime;

    const source = this.captureCtx.createMediaStreamSource(this.stream);
    // ScriptProcessor объявлен устаревшим, но в Electron работает везде и не
    // требует отдельного файла обработчика, который пришлось бы отдавать с
    // сервера. Для голоса нагрузки он не создаёт.
    this.processor = this.captureCtx.createScriptProcessor(FRAME_SAMPLES, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);

      const samples = new Int16Array(input.length);
      let peak = 0;
      for (let i = 0; i < input.length; i++) {
        const clamped = Math.max(-1, Math.min(1, input[i]));
        samples[i] = clamped * 32767;
        const abs = Math.abs(clamped);
        if (abs > peak) peak = abs;
      }
      this.onLevel?.(peak);
      this.ws.send(packFrame(this.peerId, samples));
    };

    source.connect(this.processor);
    // Без подключения к выходу обработчик в Chromium не вызывается; громкость
    // выкручена в ноль, иначе человек слышал бы сам себя.
    const silence = this.captureCtx.createGain();
    silence.gain.value = 0;
    this.processor.connect(silence);
    silence.connect(this.captureCtx.destination);

    this.onMessage = async (event) => {
      if (!(event.data instanceof Blob) && !(event.data instanceof ArrayBuffer)) return;
      const buffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      if (buffer.byteLength < 5) return;
      const { senderId, samples } = unpackFrame(buffer);
      if (senderId !== this.peerId) return;
      this.enqueue(samples);
    };
    this.ws.addEventListener('message', this.onMessage);
  }

  // Кадры ставятся в очередь по времени, а не проигрываются сразу: сеть
  // доставляет их неравномерно, и без небольшого запаса речь будет щёлкать.
  enqueue(samples) {
    const ctx = this.playbackCtx;
    if (!ctx) return;

    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);

    const minStart = ctx.currentTime + 0.08;
    if (this.playAt < minStart) this.playAt = minStart;
    node.start(this.playAt);
    this.playAt += buffer.duration;
  }

  setMuted(value) {
    this.muted = value;
    this.stream?.getAudioTracks()?.forEach((t) => { t.enabled = !value; });
  }

  stop() {
    if (this.onMessage) this.ws?.removeEventListener('message', this.onMessage);
    this.processor?.disconnect();
    this.stream?.getTracks()?.forEach((t) => t.stop());
    this.captureCtx?.close().catch(() => {});
    this.playbackCtx?.close().catch(() => {});
    this.processor = null;
    this.stream = null;
    this.captureCtx = null;
    this.playbackCtx = null;
  }
}
