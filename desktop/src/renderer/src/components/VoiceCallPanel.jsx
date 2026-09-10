import React, { useState, useEffect, useRef } from 'react';
import { AudioRelay } from '../lib/audioRelay';

// Голосовой звонок между двумя сотрудниками.
//
// Звук идёт через сервер по тому же WebSocket, что и переписка. Прямое
// соединение (WebRTC) в корпоративных сетях, как правило, не устанавливается:
// исходящий UDP закрыт, NAT симметричный. Лечится это TURN-сервером — то есть
// отдельной службой, портами и расходами. Здесь достаточно того, что уже
// работает: если открыт чат, открыт и звонок.
const RING_TIMEOUT_MS = 45000;

export default function VoiceCallPanel({ call, currentUser, wsClient, onEnd }) {
  // call: { peer: {id, full_name}, direction: 'outgoing' | 'incoming', offer? }
  const [phase, setPhase] = useState(call.direction === 'incoming' ? 'ringing' : 'calling');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const relayRef = useRef(null);

  const send = (payload) => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ ...payload, targetUserId: call.peer.id }));
    }
  };

  const cleanup = () => {
    relayRef.current?.stop();
    relayRef.current = null;
  };

  const hangUp = (notifyPeer = true) => {
    if (notifyPeer) send({ type: 'call_end' });
    cleanup();
    onEnd();
  };

  // Микрофон открывается только когда разговор реально начался — не в момент
  // набора и не при входящем звонке, на который ещё не ответили.
  const startAudio = async () => {
    try {
      const relay = new AudioRelay({ ws: wsClient, peerId: call.peer.id });
      await relay.start();
      relayRef.current = relay;
      relay.setMuted(muted);
      setPhase('active');
      return true;
    } catch (err) {
      setError(
        err.name === 'NotAllowedError' || err.name === 'NotFoundError'
          ? 'Нет доступа к микрофону. Проверьте: Параметры → Конфиденциальность → Микрофон.'
          : 'Не удалось включить микрофон: ' + err.message
      );
      setPhase('failed');
      return false;
    }
  };

  const startOutgoing = () => {
    // Описание соединения не передаётся: звук идёт через сервер, договариваться
    // о прямом канале не о чем. Сообщение служит только вызовом.
    send({ type: 'call_offer' });
  };

  const acceptIncoming = async () => {
    if (await startAudio()) send({ type: 'call_answer' });
  };

  const rejectIncoming = () => {
    send({ type: 'call_rejected' });
    cleanup();
    onEnd();
  };

  useEffect(() => {
    if (call.direction === 'outgoing') startOutgoing();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Сигнализация от собеседника.
  useEffect(() => {
    if (!wsClient) return;

    const onMessage = async (e) => {
      // Двоичные кадры — это сам звук, его разбирает AudioRelay.
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.senderId && msg.senderId !== call.peer.id) return;

      if (msg.type === 'call_answer') {
        // Собеседник взял трубку — теперь можно включать микрофон.
        await startAudio();
      } else if (msg.type === 'call_rejected') {
        setError('Сотрудник отклонил звонок');
        setPhase('failed');
      } else if (msg.type === 'call_end') {
        hangUp(false);
      } else if (msg.type === 'call_unavailable') {
        setError(msg.reason || 'Сотрудник недоступен');
        setPhase('failed');
      } else if (msg.type === 'call_denied') {
        setError(msg.reason || 'Звонки недоступны для вашей роли');
        setPhase('failed');
      }
    };

    wsClient.addEventListener('message', onMessage);
    return () => wsClient.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsClient, call.peer.id]);

  // Счётчик длительности разговора.
  useEffect(() => {
    if (phase !== 'active') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Никто не берёт трубку — не звоним бесконечно.
  useEffect(() => {
    if (phase !== 'calling') return;
    const id = setTimeout(() => {
      setError('Сотрудник не ответил');
      setPhase('failed');
      send({ type: 'call_end' });
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    relayRef.current?.setMuted(next);
  };

  const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const peerName = call.peer.full_name || call.peer.username || 'Сотрудник';

  const statusLine = {
    calling: 'Вызываем…',
    ringing: 'Входящий звонок',
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

        {(phase === 'active' || phase === 'calling') && (
          <>
            {phase === 'active' && (
              <button className={`call-btn mute ${muted ? 'on' : ''}`} onClick={toggleMute}>
                {muted ? '🔇 Микрофон выкл.' : '🎤 Микрофон'}
              </button>
            )}
            <button className="call-btn decline" onClick={() => hangUp(true)}>
              Завершить
            </button>
          </>
        )}

        {phase === 'failed' && (
          <button className="call-btn decline" onClick={() => hangUp(false)}>
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
}
