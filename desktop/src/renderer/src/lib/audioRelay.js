import {
  packFrame,
  unpackFrame,
  isSilent,
  JitterScheduler,
  SAMPLE_RATE,
  FRAME_SAMPLES
} from './audio-frames.mjs';

// Передача голоса через сервер по уже открытому WebSocket.
//
// Почему не WebRTC напрямую: в корпоративных сетях прямое соединение между
// двумя компьютерами почти всегда не устанавливается — исходящий UDP закрыт,
// NAT симметричный. Штатное лекарство от этого — TURN-сервер, но это отдельная
// служба, отдельные порты и отдельные расходы. Здесь звук идёт по тому же
// соединению, что и переписка, через 443 порт: если работает чат — работает и
// звонок, настраивать в сети нечего.
//
// Захват вынесен в AudioWorklet. Прежний ScriptProcessorNode работает на том же
// потоке, что и интерфейс: каждая перерисовка React — а она случается на каждое
// входящее сообщение — крала у него время, и звук рвался. Worklet живёт на
// отдельном звуковом потоке и на перерисовки не смотрит.
//
// Паузы не передаются вовсе (см. isSilent): разговор примерно наполовину
// состоит из молчания, и это самое дешёвое сжатие — без кодека и без потери
// качества.

// Код обработчика отдаётся через Blob, а не отдельным файлом: интерфейс
// приходит с сервера собранным, и лишний путь пришлось бы отдельно раздавать и
// отдельно чинить при смене адреса.
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions.frameSize;
    this.buffer = new Float32Array(this.frameSize);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.frameSize) {
        // Копия обязательна: буфер тут же начнёт заполняться заново.
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export class AudioRelay {
  constructor({ ws, peerId, onLevel, onStats }) {
    this.ws = ws;
    this.peerId = peerId;
    this.onLevel = onLevel;
    this.onStats = onStats;
    this.muted = false;
    this.stopped = false;
    this.scheduler = new JitterScheduler();
    this.stats = { sent: 0, received: 0, skippedSilent: 0 };
  }

  // stop() может прийти в любой момент запуска: звонок закрыли, пока Windows
  // спрашивала разрешение на микрофон. Раньше поток и звуковой контекст
  // создавались уже после закрытия и жили до перезапуска приложения —
  // индикатор микрофона так и горел. Поэтому после каждого ожидания запуск
  // проверяет, не остановили ли его, и при любой ошибке сам всё освобождает.
  async start() {
    if (this.stopped) throw abortError();

    // Отдельная проверка с внятным объяснением: без неё сотрудник видит
    // «Cannot read properties of undefined» и не может ничего с этим сделать.
    // mediaDevices нет, когда страница открыта по незащищённому протоколу —
    // Chromium прячет её на любом origin, кроме localhost.
    if (!navigator.mediaDevices?.getUserMedia) {
      const secure = window.isSecureContext;
      throw new Error(
        secure
          ? 'Микрофон недоступен в этом окне'
          : 'Звонки работают только по защищённому соединению (https). ' +
            'Сейчас приложение подключено по http — обратитесь к администратору.'
      );
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        throw abortError();
      }
      this.stream = stream;

      // Один контекст на приём и передачу: два независимых контекста мешали
      // подавлению эха — браузер отменяет только тот звук, который сам же и
      // вывел, и о чужом контексте он ничего не знает.
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      this.scheduler.reset();

      await this.startCapture();
      if (this.stopped) throw abortError();
      this.attachReceiver();
    } catch (err) {
      this.release();
      throw err;
    }
  }

  async startCapture() {
    const ctx = this.ctx;
    const source = ctx.createMediaStreamSource(this.stream);

    try {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      this.workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(this.workletUrl);
      if (this.stopped) throw abortError();

      this.capture = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { frameSize: FRAME_SAMPLES }
      });
      this.capture.port.onmessage = (event) => this.sendSamples(event.data);
      source.connect(this.capture);
      this.captureKind = 'worklet';
    } catch (err) {
      // Остановленный звонок запасной путь не ищет: контекст уже закрыт.
      if (this.stopped) throw abortError();
      // Запасной путь на случай, если Worklet недоступен. Хуже по качеству, но
      // разговор состоится — а это важнее.
      console.warn('[Звонок] AudioWorklet недоступен, перехожу на ScriptProcessor:', err?.message);
      this.capture = ctx.createScriptProcessor(1024, 1, 1);
      this.capture.onaudioprocess = (event) => this.sendSamples(event.inputBuffer.getChannelData(0));
      source.connect(this.capture);
      // Без подключения к выходу обработчик в Chromium не вызывается; громкость
      // в ноль, иначе человек слышит сам себя.
      const silence = ctx.createGain();
      silence.gain.value = 0;
      this.capture.connect(silence);
      silence.connect(ctx.destination);
      this.captureKind = 'script-processor';
    }
  }

  sendSamples(input) {
    if (this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (isSilent(input)) {
      this.stats.skippedSilent++;
      this.onLevel?.(0);
      return;
    }

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
    this.stats.sent++;
  }

  attachReceiver() {
    this.onMessage = (event) => {
      // Двоичный режим сокета задаётся при его создании (binaryType =
      // 'arraybuffer'). Blob пришлось бы разбирать асинхронно, а значит кадры
      // могли бы разойтись местами — речь звучала бы рвано и не по порядку.
      if (!(event.data instanceof ArrayBuffer)) return;

      const frame = unpackFrame(event.data);
      if (!frame || frame.senderId !== this.peerId) return;

      this.stats.received++;
      this.enqueue(frame.samples);
      this.onStats?.(this.stats);
    };
    this.ws.addEventListener('message', this.onMessage);
  }

  enqueue(samples) {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;

    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.start(this.scheduler.schedule(ctx.currentTime, buffer.duration));
  }

  setMuted(value) {
    this.muted = value;
    this.stream?.getAudioTracks()?.forEach((track) => { track.enabled = !value; });
  }

  // Можно звать сколько угодно раз и в любой момент, в том числе посреди start().
  stop() {
    this.stopped = true;
    this.release();
  }

  release() {
    if (this.onMessage) this.ws?.removeEventListener('message', this.onMessage);
    this.onMessage = null;
    if (this.capture) {
      try { this.capture.port ? (this.capture.port.onmessage = null) : (this.capture.onaudioprocess = null); } catch {}
      try { this.capture.disconnect(); } catch {}
    }
    this.stream?.getTracks()?.forEach((track) => track.stop());
    this.ctx?.close().catch(() => {});
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);

    this.capture = null;
    this.stream = null;
    this.ctx = null;
    this.workletUrl = null;
  }
}

// Отмена запуска отличается от сбоя: панели звонка не нужно показывать
// «не удалось включить микрофон», если звонок просто закрыли.
function abortError() {
  const message = 'Звонок завершён до включения микрофона';
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
