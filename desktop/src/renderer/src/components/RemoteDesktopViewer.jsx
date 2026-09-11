import React, { useState, useEffect, useRef, useCallback } from 'react';
import { pointToFrame, MoveThrottle } from '../lib/remote-pointer.mjs';

export default function RemoteDesktopViewer({ sessionId, targetUser, wsClient, pendingOffer, onEndSession }) {
  const [scaleMode, setScaleMode] = useState('fit');
  const [remoteStream, setRemoteStream] = useState(null);
  const [statusText, setStatusText] = useState('Устанавливаем соединение с экраном сотрудника…');
  const [accessLevel, setAccessLevel] = useState('full');
  const [isRejected, setIsRejected] = useState(false);

  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [transferState, setTransferState] = useState(null);
  const [screens, setScreens] = useState([]);
  const [activeScreenId, setActiveScreenId] = useState(null);
  const [clipboardSync, setClipboardSync] = useState(false);
  const [linkStats, setLinkStats] = useState(null);
  const clipboardSyncRef = useRef(false);
  const lastClipboardRef = useRef('');

  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const moveThrottleRef = useRef(new MoveThrottle({ intervalMs: 33 }));

  // Обработчик завершения приходит из App новой функцией на каждую его
  // перерисовку — а перерисовывается App на каждое входящее сообщение. Держать
  // такую функцию среди зависимостей соединения значило пересоздавать
  // RTCPeerConnection по десять раз в минуту: картинка не успевала появиться.
  const onEndSessionRef = useRef(onEndSession);
  useEffect(() => { onEndSessionRef.current = onEndSession; }, [onEndSession]);

  // Как только картинка пошла — сразу забираем фокус, чтобы не заставлять
  // оператора догадываться, что по экрану нужно сначала кликнуть.
  useEffect(() => {
    if (remoteStream && accessLevel === 'full') stageRef.current?.focus();
  }, [remoteStream, accessLevel]);

  // Поток приходит раньше, чем появляется сам элемент <video>: до этого
  // момента показывается заставка «устанавливаем соединение». Присваивать
  // srcObject прямо в обработчике было нечему — ссылка ещё пустая, и экран
  // оставался чёрным навсегда. Присваиваем после того, как элемент появился.
  useEffect(() => {
    if (videoRef.current && remoteStream) {
      videoRef.current.srcObject = remoteStream;
      videoRef.current.play?.().catch(() => {});
    }
  }, [remoteStream]);

  useEffect(() => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnectionRef.current = pc;

    // Кандидаты нередко приходят раньше описания соединения. Добавить их в
    // этот момент нельзя — вызов бросает исключение, и кандидат теряется
    // насовсем. Потерянный кандидат означает несостоявшееся соединение, а
    // выглядит это как «висит на подключении».
    let remoteDescriptionSet = false;
    const pendingCandidates = [];
    const addCandidate = async (candidate) => {
      if (!remoteDescriptionSet) {
        pendingCandidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('RD: кандидат отклонён', err?.message);
      }
    };

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
        setStatusText('Подключено');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        setStatusText('Соединение не установилось. Закройте окно и попробуйте снова.');
      } else if (pc.connectionState === 'disconnected') {
        setStatusText('Связь прервалась, восстанавливаем…');
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
          type: 'rd_ice_candidate',
          sessionId,
          targetUserId: targetUser.id,
          candidate: event.candidate
        }));
      }
    };

    // Answers an offer exactly once — the same offer can arrive both buffered
    // from App (sent before this component existed) and through the live
    // listener below, and answering twice throws on the peer connection.
    let offerAnswered = false;
    const answerOffer = async (sdp) => {
      if (offerAnswered) return;
      offerAnswered = true;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      remoteDescriptionSet = true;

      // Кандидаты, пришедшие до описания, добавляются теперь — иначе они бы
      // так и остались невостребованными.
      while (pendingCandidates.length) {
        await addCandidate(pendingCandidates.shift());
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
          type: 'rd_webrtc_answer',
          sessionId,
          targetUserId: targetUser.id,
          sdp: answer
        }));
      }
    };

    if (pendingOffer && pendingOffer.sessionId === sessionId) {
      answerOffer(pendingOffer.sdp).catch((err) => console.error('RD offer error:', err));
    }

    const handleWsMessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.sessionId !== sessionId) return;

        if (msg.type === 'rd_response') {
          if (!msg.accepted) {
            setIsRejected(true);
            setStatusText('Сотрудник отклонил запрос на удаленный доступ.');
          } else {
            setStatusText('Сотрудник разрешил доступ. Запуск видеопотока 60 FPS...');
            if (msg.accessLevel) setAccessLevel(msg.accessLevel);
          }
        } else if (msg.type === 'rd_webrtc_offer') {
          await answerOffer(msg.sdp);
        } else if (msg.type === 'rd_screens') {
          setScreens(msg.screens || []);
          setActiveScreenId((prev) => prev || msg.screens?.[0]?.id || null);
        } else if (msg.type === 'rd_clipboard') {
          // Сотрудник скопировал текст у себя — кладём его в буфер оператора.
          if (clipboardSyncRef.current && typeof msg.text === 'string') {
            lastClipboardRef.current = msg.text;
            window.electronAPI?.rdClipboardWrite?.(msg.text);
          }
        } else if (msg.type === 'rd_ice_candidate' && msg.candidate) {
          await addCandidate(msg.candidate);
        } else if (msg.type === 'rd_end') {
          // alert() останавливает всё окно: пока его не закроют, не идут ни
          // сообщения, ни звонки. Для сообщения о завершении сеанса это
          // чрезмерно — показываем его в самом окне сеанса.
          setStatusText('Сеанс завершён сотрудником.');
          setRemoteStream(null);
          setTimeout(() => onEndSessionRef.current?.(), 1500);
        }
      } catch (err) {
        console.error('RD message error:', err);
      }
    };

    if (wsClient) {
      wsClient.addEventListener('message', handleWsMessage);
    }

    // Latency and FPS used to be invented here with Math.random() on a timer
    // and displayed as measurements — they read as a healthy 8-16 ms / 60 fps
    // even when no stream existed at all. Real figures have to come from the
    // WebRTC connection (RTCPeerConnection.getStats), so until the stream is
    // wired up nothing is claimed.

    return () => {
      if (wsClient) {
        wsClient.removeEventListener('message', handleWsMessage);
      }
      pc.close();
    };
    // targetUser.id, а не сам объект: объект приходит новым на каждой
    // перерисовке App и пересоздавал бы соединение вместе с картинкой.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, targetUser.id, wsClient]);

  const sendInputEvent = useCallback((inputEvent) => {
    if (accessLevel !== 'full') return;
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'rd_input_event',
        sessionId,
        targetUserId: targetUser.id,
        event: inputEvent
      }));
    }
  }, [accessLevel, wsClient, sessionId, targetUser.id]);

  const canControl = accessLevel === 'full';

  // Передача файла на машину сотрудника. Идёт по тому же каналу сеанса, что и
  // сигнализация: сервер уже проверяет, что оба участника подтвердили сеанс,
  // и не нужен ни отдельный маршрут, ни прямое соединение (оно может не
  // установиться за строгим NAT). Ограничение по размеру — чтобы одно
  // сообщение не забило канал: сеанс идёт по нему же.
  const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;

  useEffect(() => { clipboardSyncRef.current = clipboardSync; }, [clipboardSync]);

  const toggleClipboardSync = () => {
    const next = !clipboardSync;
    setClipboardSync(next);
    // Сотрудник обязан видеть, что буфер стал общим — у него в панели сеанса
    // появляется отметка. Молча читать чужой буфер недопустимо.
    if (wsClient?.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({
        type: 'rd_clipboard_mode',
        sessionId,
        targetUserId: targetUser.id,
        enabled: next
      }));
    }
  };

  // Свой буфер опрашивается: событий об изменении Windows не присылает.
  useEffect(() => {
    if (!clipboardSync || !window.electronAPI?.rdClipboardRead) return;
    const id = setInterval(async () => {
      try {
        const text = await window.electronAPI.rdClipboardRead();
        if (typeof text === 'string' && text && text !== lastClipboardRef.current) {
          lastClipboardRef.current = text;
          if (wsClient?.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: 'rd_clipboard', sessionId, targetUserId: targetUser.id, text }));
          }
        }
      } catch {}
    }, 1200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipboardSync, sessionId]);

  const switchScreen = (screenId) => {
    setActiveScreenId(screenId);
    if (wsClient?.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ type: 'rd_select_screen', sessionId, targetUserId: targetUser.id, screenId }));
    }
  };

  // Настоящие показатели связи вместо удалённых выдуманных: берутся из самого
  // соединения. Пока данных нет, ничего не заявляется.
  useEffect(() => {
    if (!remoteStream) return;
    const id = setInterval(async () => {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let fps = null;
        let rttMs = null;
        let width = null;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (typeof report.framesPerSecond === 'number') fps = Math.round(report.framesPerSecond);
            if (typeof report.frameWidth === 'number') width = report.frameWidth;
          }
          if (report.type === 'candidate-pair' && report.nominated && typeof report.currentRoundTripTime === 'number') {
            rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        });
        setLinkStats({ fps, rttMs, width });
      } catch {}
    }, 2000);
    return () => clearInterval(id);
  }, [remoteStream]);

  const handleSendFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_TRANSFER_BYTES) {
        setTransferState({ kind: 'error', text: `Файл больше 10 МБ (${Math.round(file.size / 1048576)} МБ) — передайте его через чат` });
        return;
      }
      setTransferState({ kind: 'progress', text: `Передаём «${file.name}»…` });
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({
            type: 'rd_file',
            sessionId,
            targetUserId: targetUser.id,
            fileName: file.name,
            size: file.size,
            data: btoa(binary)
          }));
          setTransferState({ kind: 'done', text: `«${file.name}» отправлен в папку «Загрузки» сотрудника` });
        } else {
          setTransferState({ kind: 'error', text: 'Нет связи с сервером' });
        }
      } catch (err) {
        setTransferState({ kind: 'error', text: 'Не удалось прочитать файл: ' + err.message });
      }
    };
    input.click();
  };

  // Точка окна → доля кадра. Сама арифметика лежит в lib/remote-pointer.js и
  // проверяется тестами: промах курсора виден только на чужом экране и вдвоём.
  const framePoint = (clientX, clientY) => {
    const video = videoRef.current;
    if (!video) return null;
    return pointToFrame(clientX, clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
  };

  const MOUSE_BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };

  // Мышь порождает больше сотни событий в секунду, и каждое уходило отдельным
  // сообщением по тому же соединению, что несёт видео сеанса и звук разговора.
  // Тридцати в секунду достаточно: быстрее движение всё равно не различить.
  const handleMouseMove = (e) => {
    if (!canControl) return;
    const point = framePoint(e.clientX, e.clientY);
    if (!point) return;
    moveThrottleRef.current.push(point, (p) => sendInputEvent({ type: 'move', x: p.x, y: p.y }));
  };

  // Мышь остановилась — придержанную точку надо всё-таки отправить, иначе
  // курсор замрёт не там, где его отпустили.
  useEffect(() => {
    const throttle = moveThrottleRef.current;
    const id = setInterval(() => {
      throttle.flush((p) => sendInputEvent({ type: 'move', x: p.x, y: p.y }));
    }, 60);
    return () => clearInterval(id);
  }, [sendInputEvent]);

  const handleMouseDown = (e) => {
    if (!canControl) return;
    e.preventDefault();
    // preventDefault отменяет и установку фокуса — без этой строки область
    // никогда его не получала, и клавиатура не работала вообще.
    e.currentTarget.focus();
    const point = framePoint(e.clientX, e.clientY);
    // Нажатие обязано попасть точно, поэтому придержанное движение
    // отправляется немедленно и только потом само нажатие.
    moveThrottleRef.current.flush((p) => sendInputEvent({ type: 'move', x: p.x, y: p.y }));
    sendInputEvent({ type: 'down', button: MOUSE_BUTTONS[e.button] || 'left', ...(point || {}) });
  };

  const handleMouseUp = (e) => {
    if (!canControl) return;
    e.preventDefault();
    const point = framePoint(e.clientX, e.clientY);
    sendInputEvent({ type: 'up', button: MOUSE_BUTTONS[e.button] || 'left', ...(point || {}) });
  };

  const handleWheel = (e) => {
    if (!canControl) return;
    // deltaY вниз положительный, у колеса Windows — наоборот.
    sendInputEvent({ type: 'wheel', delta: e.deltaY > 0 ? -1 : 1 });
  };

  const handleContextMenu = (e) => {
    // Иначе поверх удалённого экрана открылось бы меню самого приложения.
    if (canControl) e.preventDefault();
  };

  const handleKeyDown = (e) => {
    if (!canControl) return;
    e.preventDefault();
    sendInputEvent({
      type: 'key',
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey
    });
  };

  return (
    <div className="rd-viewer-container">
      <div className="rd-viewer-toolbar">
        <div className="rd-toolbar-left">
          <span className="rd-status-indicator online">●</span>
          <span className="rd-user-title">
            {targetUser.full_name || targetUser.username}
          </span>
          <span className="rd-badge">
            {accessLevel === 'full' ? '🎮 Полный доступ' : '👁️ Только просмотр'}
          </span>
        </div>

        <div className="rd-toolbar-center">
          {transferState ? (
            <span className={`rd-transfer-note ${transferState.kind}`}>{transferState.text}</span>
          ) : linkStats ? (
            <span className="rd-metric-item">
              {linkStats.rttMs !== null && <>Задержка: <strong>{linkStats.rttMs} мс</strong>&nbsp;&nbsp;</>}
              {linkStats.fps !== null && <>Кадры: <strong>{linkStats.fps}/с</strong>&nbsp;&nbsp;</>}
              {linkStats.width && <>Разрешение: <strong>{linkStats.width}px</strong></>}
            </span>
          ) : null}
        </div>

        <div className="rd-toolbar-right">
          {screens.length > 1 && (
            <select
              className="rd-screen-select"
              value={activeScreenId || ''}
              onChange={(e) => switchScreen(e.target.value)}
              title="Какой монитор сотрудника показывать"
            >
              {screens.map((s, i) => (
                <option key={s.id} value={s.id}>{s.name || `Экран ${i + 1}`}</option>
              ))}
            </select>
          )}
          <button
            className={`rd-btn${clipboardSync ? ' active' : ''}`}
            title="Общий буфер обмена: скопированный текст переносится между компьютерами"
            disabled={!canControl || !remoteStream}
            onClick={toggleClipboardSync}
          >
            {clipboardSync ? '📋 Буфер: общий' : '📋 Буфер'}
          </button>
          <button
            className="rd-btn"
            title="Передать файл в папку «Загрузки» сотрудника"
            disabled={!canControl || !remoteStream}
            onClick={handleSendFile}
          >
            Передать файл
          </button>
          <button
            className="rd-btn"
            onClick={() => setScaleMode(scaleMode === 'fit' ? 'original' : 'fit')}
          >
            {scaleMode === 'fit' ? 'Масштаб 1:1' : 'По размеру'}
          </button>
          <button className="rd-btn-danger" onClick={onEndSession}>
            ✕ Завершить сеанс
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`rd-video-area${canControl ? ' controllable' : ''}${keyboardCaptured ? ' focused' : ''}`}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        onFocus={() => setKeyboardCaptured(true)}
        onBlur={() => setKeyboardCaptured(false)}
      >
        {canControl && !keyboardCaptured && remoteStream && (
          <div className="rd-focus-hint">Нажмите на экран, чтобы управлять клавиатурой</div>
        )}
        {remoteStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={'rd-video-stream ' + (scaleMode === 'fit' ? 'fit' : 'original')}
          />
        ) : (
          <div className="rd-connecting-overlay">
            {isRejected ? (
              <div className="rd-rejected-box">
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>⛔</div>
                <h3 style={{ color: '#ef4444', marginBottom: '8px' }}>Запрос отклонен</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                  Сотрудник {targetUser.full_name} отклонил запрос на удаленный рабочий стол.
                </p>
                <button className="btn btn-secondary" onClick={onEndSession}>
                  Закрыть окно
                </button>
              </div>
            ) : (
              <div className="rd-loading-box">
                <div className="rd-spinner" />
                <h3 style={{ marginTop: '16px', color: '#f8fafc' }}>Удаленный рабочий стол</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px' }}>{statusText}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
