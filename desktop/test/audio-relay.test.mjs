import test from 'node:test';
import assert from 'node:assert';
import {
  packFrame,
  unpackFrame,
  isSilent,
  JitterScheduler,
  FRAME_SAMPLES,
  SAMPLE_RATE
} from '../src/renderer/src/lib/audio-frames.mjs';

// Звук в разговоре идёт через сервер по тому же WebSocket, что и переписка.
// Всё, что можно проверить без микрофона и без звуковой карты, вынесено сюда:
// упаковка кадра, порог тишины и расписание воспроизведения. Именно в
// расписании и жила ошибка, из-за которой к концу долгого разговора
// собеседника слышно с запозданием в несколько секунд.

test('кадр переживает упаковку и распаковку без потерь', () => {
  const samples = Int16Array.from([0, 1, -1, 32767, -32768, 12345, -12345]);
  const { senderId, samples: back } = unpackFrame(packFrame(4242, samples));

  assert.strictEqual(senderId, 4242);
  assert.strictEqual(back.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Обратно приходят доли от -1 до 1 — сравниваем с той же точностью.
    assert.ok(Math.abs(back[i] - samples[i] / 32768) < 1e-6, `отсчёт ${i}`);
  }
});

test('идентификатор отправителя занимает ровно четыре первых байта', () => {
  const frame = packFrame(1, Int16Array.from([7]));
  assert.strictEqual(frame.byteLength, 4 + 2, 'заголовок плюс один отсчёт');
  assert.strictEqual(new DataView(frame).getUint32(0, false), 1);
});

test('большой идентификатор не переполняется', () => {
  // Сервер читает те же четыре байта без знака: отрицательным номер быть не может.
  const frame = packFrame(4000000000, Int16Array.from([0]));
  assert.strictEqual(unpackFrame(frame).senderId, 4000000000);
});

test('обрезок кадра не роняет разбор', () => {
  for (const size of [0, 1, 3, 4, 5]) {
    const result = unpackFrame(new ArrayBuffer(size));
    assert.ok(result === null || result.samples.length >= 0, `длина ${size}`);
  }
});

test('тишина распознаётся, речь — нет', () => {
  const silence = new Float32Array(FRAME_SAMPLES); // все нули
  assert.strictEqual(isSilent(silence), true);

  const quietHum = new Float32Array(FRAME_SAMPLES).fill(0.0005);
  assert.strictEqual(isSilent(quietHum), true, 'ровный фон микрофона — не речь');

  const speech = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(i / 8) * 0.2;
  assert.strictEqual(isSilent(speech), false);
});

// ── Расписание воспроизведения ──────────────────────────────────────────────

test('первый кадр ставится с небольшим запасом, а не сразу', () => {
  // Без запаса сеть успевает опоздать с любым следующим кадром, и речь щёлкает.
  const scheduler = new JitterScheduler();
  const at = scheduler.schedule(10.0, FRAME_SAMPLES / SAMPLE_RATE);
  assert.ok(at > 10.0, 'кадр не должен играть тем же мгновением');
  assert.ok(at - 10.0 <= 0.2, 'но и запас не должен быть заметен на слух');
});

test('подряд идущие кадры выстраиваются встык', () => {
  const scheduler = new JitterScheduler();
  const duration = FRAME_SAMPLES / SAMPLE_RATE;

  const first = scheduler.schedule(10.0, duration);
  const second = scheduler.schedule(10.0, duration);
  const third = scheduler.schedule(10.0, duration);

  assert.ok(Math.abs(second - (first + duration)) < 1e-9, 'без щелчков между кадрами');
  assert.ok(Math.abs(third - (second + duration)) < 1e-9);
});

test('накопленное отставание сбрасывается, а не растёт бесконечно', () => {
  // Часы отправителя чуть быстрее часов получателя — за долгий разговор
  // очередь уползает вперёд, и собеседника слышно всё позже. Раньше потолка
  // не было вовсе: задержка росла, пока разговор не заканчивали.
  const scheduler = new JitterScheduler();
  const duration = FRAME_SAMPLES / SAMPLE_RATE;

  let now = 10.0;
  let last = 0;
  for (let i = 0; i < 2000; i++) {
    last = scheduler.schedule(now, duration);
    now += duration * 0.98; // получатель отстаёт на 2 % — обычное расхождение часов
  }

  assert.ok(
    last - now <= JitterScheduler.MAX_LEAD_SECONDS + 1e-6,
    `отставание ${(last - now).toFixed(2)} с не должно превышать потолок`
  );
});

test('после паузы в разговоре расписание начинается заново', () => {
  // Собеседник помолчал полминуты — накопленная точка воспроизведения давно в
  // прошлом, и играть «встык» к ней значит выбросить кадр целиком.
  const scheduler = new JitterScheduler();
  const duration = FRAME_SAMPLES / SAMPLE_RATE;

  scheduler.schedule(10.0, duration);
  const afterPause = scheduler.schedule(40.0, duration);

  assert.ok(afterPause >= 40.0, 'кадр не должен планироваться в прошлое');
  assert.ok(afterPause - 40.0 <= 0.2);
});

test('счётчик отброшенных кадров помогает объяснить плохую связь', () => {
  const scheduler = new JitterScheduler();
  const duration = FRAME_SAMPLES / SAMPLE_RATE;

  let now = 10.0;
  for (let i = 0; i < 2000; i++) {
    scheduler.schedule(now, duration);
    now += duration * 0.9;
  }
  assert.ok(scheduler.resyncs > 0, 'пересборка очереди должна учитываться');
});
