import React, { useState, useEffect, useRef } from 'react';
import { AudioRelay } from '../lib/audioRelay';
import { callSignalAction, ringTimeoutAction, RING_TIMEOUT_MS } from '../lib/call-signal.mjs';

// Голосовой звонок между двумя сотрудниками.
//
// Звук идёт через сервер по тому же WebSocket, что и переписка. Прямое
// соединение (WebRTC) в корпоративных сетях, как правило, не устанавливается:
// исходящий UDP закрыт, NAT симметричный. Лечится это TURN-сервером — то есть
// отдельной службой, портами и расходами. Здесь достаточно того, что уже
// работает: если открыт чат, открыт и звонок.
//
// Фазы: calling — мы звоним; ringing — звонят нам; connecting — трубку взяли,
// включается микрофон; active — разговор; failed — показана причина.

const MIC_FAILED_REASON = 'У собеседника не включился микрофон';
const CONNECTION_LOST = 'Связь с сервером прервалась — звонок завершён';

export default function VoiceCallPanel({ call, currentUser, wsClient, onEnd }) {
  // call: { peer: {id, full_name}, direction: 'outgoing' | 'incoming', offer? }
  const [phase, setPhaseState] = useState(call.direction === 'incoming' ? 'ringing' : 'calling');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  // Обработчики сокета и таймеры живут дольше одной перерисовки, поэтому всё,
  // что они читают, лежит в ссылках, а не в замыкании.
  const phaseRef = useRef(phase);
  const mutedRef = useRef(false);
  const relayRef = useRef(null);
  const wsRef = useRef(wsClient);
  const aliveRef = useRef(true);
  const endedRef = useRef(false);   // звонок завершён с нашей стороны или ею учтён
  const offerSentRef = useRef(false);
  const onEndRef = useRef(onEnd);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);

  const setPhase = (next) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const send = (payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...payload, targetUserId: call.peer.id }));
      return true;
    }
    return false;
  };

  // Микрофон и звуковой контекст освобождаются на КАЖДОМ пути выхода: отказ,
  // ошибка, завершение, закрытие панели. stop() безопасен и посреди запуска.
  const releaseAudio = () => {
    const relay = relayRef.current;
    relayRef.current = null;
    relay?.stop();
  };

  const close = () => {
    endedRef.current = true;
    releaseAudio();
    if (aliveRef.current) onEndRef.current?.();
  };

  const fail = (message) => {
    endedRef.current = true;
    releaseAudio();
    if (!aliveRef.current) return;
    setError(message);
    setPhase('failed');
  };

  const hangUp = () => {
    send({ type: 'call_end' });
    close();
  };

  // Микрофон открывается только когда разговор реально начался — не в момент
  // набора и не при входящем звонке, на который ещё не ответили.
  const startAudio = async () => {
    releaseAudio();
    const relay = new AudioRelay({ ws: wsRef.current, peerId: call.peer.id });
    relayRef.current = relay;
    setPhase('connecting');

    try {
      await relay.start();
    } catch (err) {
      relay.stop();
      if (relayRef.current === relay) relayRef.current = null;
      // Звонок закрыли, пока включался микрофон, — сообщать не о чем.
      if (err?.name === 'AbortError' || !aliveRef.current || phaseRef.current !== 'connecting') return false;
      // Собеседник уже ждёт разговора — без этого он слушал бы тишину.
      send({ type: 'call_end', reason: MIC_FAILED_REASON });
      fail(
        err.name === 'NotAllowedError' || err.name === 'NotFoundError'
          ? 'Нет доступа к микрофону. Проверьте: Параметры → Конфиденциальность → Микрофон.'
          : 'Не удалось включить микрофон: ' + err.message
      );
      return false;
    }

    // Пока Windows спрашивала разрешение, панель могли закрыть или звонок
    // оборвался: микрофон не должен остаться включённым, а ответ — уйти.
    if (!aliveRef.current || relayRef.current !== relay || phaseRef.current !== 'connecting') {
      relay.stop();
      return false;
    }
    relay.setMuted(mutedRef.current);
    setPhase('active');
    return true;
  };

  const acceptIncoming = async () => {
    if (phaseRef.current !== 'ringing') return;
    if (await startAudio()) send({ type: 'call_answer' });
  };

  const rejectIncoming = () => {
    send({ type: 'call_rejected' });
    close();
  };

  // Связь с сервером оборвалась — сервер сам завершает звонок и сообщает
  // собеседнику. Звук через новое соединение уже не пойдёт, поэтому звонок
  // закрывается честно, с объяснением, а не висит в тишине.
  const onConnectionLost = () => {
    if (phaseRef.current === 'failed' || endedRef.current) return;
    fail(CONNECTION_LOST);
  };

  useEffect(() => {
    aliveRef.current = true;
    // StrictMode в разработке подключает эффект дважды — вызов уходит один раз.
    if (call.direction === 'outgoing' && !offerSentRef.current) {
      offerSentRef.current = true;
      // Описание соединения не передаётся: звук идёт через сервер, договариваться
      // о прямом канале не о чем. Сообщение служит только вызовом.
      send({ type: 'call_offer' });
    }
    return () => {
      aliveRef.current = false;
      releaseAudio();
      // Панель убрали, не завершив звонок (например, выход из учётной записи):
      // собеседник должен об этом узнать. Проверка на следующем витке — чтобы
      // повторное подключение эффекта в StrictMode не завершало звонок.
      setTimeout(() => {
        if (aliveRef.current || endedRef.current) return;
        if (['calling', 'connecting', 'active'].includes(phaseRef.current)) send({ type: 'call_end' });
        endedRef.current = true;
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Сигнализация от собеседника.
  useEffect(() => {
    if (!wsClient) return;
    const previous = wsRef.current;
    wsRef.current = wsClient;
    if (previous && previous !== wsClient) onConnectionLost();

    const onMessage = (e) => {
      // Двоичные кадры — это сам звук, его разбирает AudioRelay.
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      const result = callSignalAction(
        { phase: phaseRef.current, direction: call.direction, peerId: call.peer.id },
        msg
      );
      if (result.action === 'start-audio') startAudio();
      else if (result.action === 'dismiss' || result.action === 'close') close();
      else if (result.action === 'fail') fail(result.error);
    };

    wsClient.addEventListener('message', onMessage);
    wsClient.addEventListener('close', onConnectionLost);
    return () => {
      wsClient.removeEventListener('message', onMessage);
      wsClient.removeEventListener('close', onConnectionLost);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsClient, call.peer.id]);

  // Счётчик длительности разговора.
  useEffect(() => {
    if (phase !== 'active') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Никто не берёт трубку — не звоним бесконечно. Входящий звонок, о котором
  // звонящий сдался, но отмена до нас не дошла, тоже не висит вечно.
  useEffect(() => {
    if (phase !== 'calling' && phase !== 'ringing') return;
    const id = setTimeout(() => {
      if (phaseRef.current !== phase) return;
      const result = ringTimeoutAction(call.direction);
      if (result.notify) send({ type: result.notify });
      if (result.action === 'fail') fail(result.error);
      else close();
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleMute = () => {
    const next = !muted;
    mutedRef.current = next;
    setMuted(next);
    relayRef.current?.setMuted(next);
  };

  const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const peerName = call.peer.full_name || call.peer.username || 'Сотрудник';

  const statusLine = {
    calling: 'Вызываем…',
    ringing: 'Входящий звонок',
    connecting: 'Включаем микрофон…',
    active: duration,
    failed: error
  }[phase];

  return (
    <div className="call-panel">
      <div className="call-panel-avatar">{peerName.slice(0, 1).toUpperCase()}</div>

      <div className="call-panel-info">
        <div className="call-panel-name">{peerName}</div>
        <div className={`call-panel-status ${phase === 'failed' ? 'error' : ''}`}>{statusLine}</div>
      </div>

      <div className="call-panel-actions">
        {phase === 'ringing' && (
          <>
            <button className="call-btn accept" onClick={acceptIncoming} title="Принять">
              Принять
            </button>
            <button className="call-btn decline" onClick={rejectIncoming} title="Отклонить">
              Отклонить
            </button>
          </>
        )}

        {(phase === 'active' || phase === 'calling' || phase === 'connecting') && (
          <>
            {phase === 'active' && (
              <button className={`call-btn mute ${muted ? 'on' : ''}`} onClick={toggleMute}>
                {muted ? '🔇 Микрофон выкл.' : '🎤 Микрофон'}
              </button>
            )}
            <button className="call-btn decline" onClick={hangUp}>
              Завершить
            </button>
          </>
        )}

        {phase === 'failed' && (
          <button className="call-btn decline" onClick={close}>
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
}
