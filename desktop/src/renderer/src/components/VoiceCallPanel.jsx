import React, { useState, useEffect, useRef } from 'react';

// Голосовой звонок между двумя сотрудниками.
//
// Сигнализация идёт по тому же WebSocket, что и переписка: call_offer /
// call_answer / ice_candidate / call_end / call_rejected. Медиа передаётся
// напрямую между машинами (WebRTC), через сервер идут только служебные
// сообщения — голос на сервер не попадает и им не хранится.
//
// Ограничение: настроен только STUN. Внутри офисной сети и для большинства
// домашних подключений этого достаточно, но при симметричном NAT (часть
// мобильных операторов, строгие корпоративные сети) соединение не установится
// — для таких случаев нужен TURN-сервер, его адрес добавляется в ICE_SERVERS.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const RING_TIMEOUT_MS = 45000;

export default function VoiceCallPanel({ call, currentUser, wsClient, onEnd }) {
  // call: { peer: {id, full_name}, direction: 'outgoing' | 'incoming', offer? }
  const [phase, setPhase] = useState(call.direction === 'incoming' ? 'ringing' : 'calling');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);
  const pendingIceRef = useRef([]);

  const send = (payload) => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ ...payload, targetUserId: call.peer.id }));
    }
  };

  const cleanup = () => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
  };

  const hangUp = (notifyPeer = true) => {
    if (notifyPeer) send({ type: 'call_end' });
    cleanup();
    onEnd();
  };

  const buildPeer = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'ice_candidate', candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      if (audioRef.current && e.streams[0]) {
        audioRef.current.srcObject = e.streams[0];
        audioRef.current.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setPhase('active');
      if (pc.connectionState === 'failed') {
        setError('Не удалось установить прямое соединение. Возможно, сеть блокирует звонки.');
        setPhase('failed');
      }
    };

    return pc;
  };

  // ICE-кандидаты могут прийти раньше, чем описание соединения — до этого
  // момента добавлять их нельзя, поэтому они копятся здесь.
  const drainPendingIce = async (pc) => {
    for (const candidate of pendingIceRef.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
    pendingIceRef.current = [];
  };

  const startOutgoing = async () => {
    try {
      const pc = await buildPeer();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      send({ type: 'call_offer', sdp: offer });
    } catch (err) {
      setError(
        err.name === 'NotAllowedError'
          ? 'Нет доступа к микрофону. Разрешите его в настройках Windows.'
          : 'Не удалось начать звонок: ' + err.message
      );
      setPhase('failed');
    }
  };

  const acceptIncoming = async () => {
    try {
      const pc = await buildPeer();
      await pc.setRemoteDescription(new RTCSessionDescription(call.offer));
      await drainPendingIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'call_answer', sdp: answer });
      setPhase('active');
    } catch (err) {
      setError(
        err.name === 'NotAllowedError'
          ? 'Нет доступа к микрофону. Разрешите его в настройках Windows.'
          : 'Не удалось принять звонок: ' + err.message
      );
      setPhase('failed');
    }
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
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.senderId && msg.senderId !== call.peer.id) return;

      const pc = pcRef.current;

      if (msg.type === 'call_answer' && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await drainPendingIce(pc);
        setPhase('active');
      } else if (msg.type === 'ice_candidate' && msg.candidate) {
        if (pc && pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        } else {
          pendingIceRef.current.push(msg.candidate);
        }
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
    const track = localStreamRef.current?.getAudioTracks()?.[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
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
      <audio ref={audioRef} autoPlay />

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
                {muted ? 'Включить микрофон' : 'Выключить микрофон'}
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
