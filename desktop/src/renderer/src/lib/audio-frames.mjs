// Разбор кадров разговора и расписание их воспроизведения.
//
// Вынесено из audioRelay.js отдельно и намеренно без единого обращения к
// Web Audio API: здесь живёт вся арифметика, которую иначе нельзя проверить
// иначе как на слух, вживую, вдвоём. Ошибка в расписании — это не падение, а
// медленно растущая задержка, которую замечают минуте на пятой разговора.

export const SAMPLE_RATE = 16000; // достаточно для речи; 8 кГц звучит телефонно
export const FRAME_SAMPLES = 512; // 32 мс — короче прежних 1024 (64 мс), отклик заметно живее

// Ниже этого порога кадр считается тишиной и не отправляется вовсе. Разговор
// примерно наполовину состоит из пауз, так что это и есть самое дешёвое
// сжатие: ни кодека, ни потери качества.
export const SILENCE_THRESHOLD = 0.0015;

// Кадр: 4 байта — идентификатор собеседника, дальше 16-битные отсчёты.
export function packFrame(peerId, samples) {
  const buffer = new ArrayBuffer(4 + samples.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, peerId, false);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(4 + i * 2, samples[i], false);
  }
  return buffer;
}

export function unpackFrame(buffer) {
  if (!buffer || buffer.byteLength < 6) return null;
  const view = new DataView(buffer);
  const senderId = view.getUint32(0, false);
  const count = Math.floor((buffer.byteLength - 4) / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(4 + i * 2, false) / 32768;
  }
  return { senderId, samples };
}

// Средний уровень, а не пиковый: одиночный щелчок не должен считаться речью,
// а ровное дыхание микрофона — должно считаться тишиной.
export function isSilent(samples, threshold = SILENCE_THRESHOLD) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += Math.abs(samples[i]);
  return sum / (samples.length || 1) < threshold;
}

/**
 * Расписание воспроизведения принятых кадров.
 *
 * Сеть доставляет кадры неравномерно, поэтому играть их сразу нельзя — речь
 * будет щёлкать. Небольшой запас сглаживает это. Но у запаса обязан быть
 * потолок: часы отправителя и получателя идут не совсем одинаково, и без
 * ограничения очередь уползает вперёд, а собеседника слышно всё позже. За
 * получасовой разговор расхождение в доли процента складывается в секунды.
 */
export class JitterScheduler {
  constructor() {
    this.playAt = 0;
    this.resyncs = 0;
  }

  /**
   * @param {number} now Текущее время звукового контекста (секунды).
   * @param {number} duration Длительность кадра (секунды).
   * @returns {number} Момент, на который ставить кадр.
   */
  schedule(now, duration) {
    const floor = now + JitterScheduler.TARGET_LEAD_SECONDS;
    const ceiling = now + JitterScheduler.MAX_LEAD_SECONDS;

    if (this.playAt < floor) {
      // Либо это первый кадр, либо собеседник помолчал и очередь опустела.
      this.playAt = floor;
    } else if (this.playAt > ceiling) {
      // Запас разросся: возвращаемся к целевому и отмечаем пересборку. На слух
      // это единичный пропуск, а не растущее отставание.
      this.playAt = floor;
      this.resyncs++;
    }

    const at = this.playAt;
    this.playAt += duration;
    return at;
  }

  reset() {
    this.playAt = 0;
  }
}

// Запас, к которому стремимся: 60 мс не слышны в разговоре, но покрывают
// обычную неравномерность доставки.
JitterScheduler.TARGET_LEAD_SECONDS = 0.06;
// Потолок: дальше задержка уже мешает перебивать собеседника, а именно так
// люди и разговаривают.
JitterScheduler.MAX_LEAD_SECONDS = 0.25;

