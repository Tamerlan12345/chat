import React, { useState, useRef, useEffect } from 'react';
import Icon from './Icon';
import { getRdIceServers, RD_HOST_CONNECT_TIMEOUT_MS } from '../lib/rd-config.mjs';
import {
  normalizeAccessLevel,
  isHostMessageAllowed,
  createEndGuard,
  ClipboardWatcher
} from '../lib/rd-session.mjs';

// Сторона сотрудника: запрос на доступ, трансляция экрана и панель сеанса.
//
// Всё, что относится к идущему сеансу, хранится отдельно от запроса в
// свойствах. Раньше компонент читал сеанс прямо из props: второй rd_prompt
// посреди сеанса подменял данные, и «Завершить доступ» закрывал не тот сеанс,
// а оператор первого продолжал смотреть экран.

// 60 кадров в секунду для рабочего стола — вред, а не польза: кодировщик
// жертвует чёткостью ради плавности, и текст расплывается. Экран меняется
// редко, поэтому 15 кадров достаточно, а весь запас качества уходит в
// разрешение. Запрашивается полное разрешение экрана.
const CAPTURE_CONSTRAINTS = {
  video: {
    frameRate: { ideal: 15, max: 20 },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    cursor: 'always'
  },
  audio: false
};

const CLIPBOARD_POLL_MS = 1200;
const SIGNALING_TYPES = new Set(['rd_webrtc_answer', 'rd_ice_candidate']);

export default function RemoteDesktopHostModal(props) {
  const data = props.promptData || props.request || {};
  const { wsClient, onClose } = props;
  // Серверы соединения из настроек сервера (null — сервер их не прислал).
  // Через ref: соединение создаётся в асинхронном обработчике согласия.
  const iceServersRef = useRef(props.iceServers ?? null);
  iceServersRef.current = props.iceServers ?? null;

  // По умолчанию — только просмотр: полный доступ сотрудник выбирает сам.
  const [accessLevel, setAccessLevel] = useState('view_only');
  const [session, setSession] = useState(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState('');
  const [clipboardRequested, setClipboardRequested] = useState(false);
  const [clipboardAllowed, setClipboardAllowed] = useState(false);
  const [notice, setNotice] = useState('');

  const sessionRef = useRef(null);          // { sessionId, operatorId, operatorName, accessLevel, ended }
  const promptRef = useRef(data);
  promptRef.current = data;
  const wsRef = useRef(wsClient);
  const streamRef = useRef(null);
  const pcRef = useRef(null);
  const connectTimerRef = useRef(null);
  const clipboardAllowedRef = useRef(false);
  const watcherRef = useRef(null);
  const answeredRef = useRef(new Set());    // запросы, на которые уже ответили
  const lastPromptRef = useRef(null);
  const switchingRef = useRef(false);
  const signalingQueueRef = useRef(Promise.resolve());
  const aliveRef = useRef(true);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const sendWs = (payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  const endGuardRef = useRef(null);
  if (!endGuardRef.current) {
    endGuardRef.current = createEndGuard((sessionId, operatorId) =>
      sendWs({ type: 'rd_end', sessionId, targetUserId: operatorId })
    );
  }

  const respond = (sessionId, accepted, extra = {}) => {
    if (!sessionId || answeredRef.current.has(sessionId)) return;
    answeredRef.current.add(sessionId);
    sendWs({ type: 'rd_response', sessionId, accepted, ...extra });
  };

  const closeModal = () => {
    if (aliveRef.current) onCloseRef.current?.();
  };

  // Единственный путь завершения сеанса. Повторный вызов ничего не делает.
  const stopSession = ({ notify = true } = {}) => {
    const s = sessionRef.current;
    if (!s || s.ended) return;
    s.ended = true;

    // Ввод отключается ПЕРВЫМ делом: даже если дальше что-то не выполнится,
    // управлять машиной уже нельзя.
    window.electronAPI?.rdInputDisable?.();
    window.electronAPI?.rdSessionEnd?.({ sessionId: s.sessionId });

    clearTimeout(connectTimerRef.current);
    connectTimerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.onicecandidate = null;
      try { pc.close(); } catch {}
    }

    watcherRef.current = null;
    clipboardAllowedRef.current = false;

    if (notify) endGuardRef.current.end(s.sessionId, s.operatorId);
    else endGuardRef.current.mark(s.sessionId);

    sessionRef.current = null;
    if (aliveRef.current) {
      setSession(null);
      setAccepting(false);
      setClipboardAllowed(false);
      setClipboardRequested(false);
    }
    closeModal();
  };

  const sendScreens = async (s) => {
    let screens = [];
    try { screens = (await window.electronAPI?.rdListScreens?.()) || []; } catch {}
    if (s.ended) return;
    // Список мониторов уходит всегда, даже если монитор один: вместе с ним
    // оператор узнаёт, что ему разрешено. Без этого его окно показывало
    // управление, файлы и буфер при доступе «только просмотр».
    sendWs({
      type: 'rd_screens',
      sessionId: s.sessionId,
      targetUserId: s.operatorId,
      screens: screens.map(({ id, name }) => ({ id, name })),
      accessLevel: s.accessLevel,
      clipboardAllowed: clipboardAllowedRef.current
    });
  };

  const handleAccept = async () => {
    if (accepting || sessionRef.current || !data.sessionId || answeredRef.current.has(data.sessionId)) return;

    const s = {
      sessionId: data.sessionId,
      operatorId: data.operatorId,
      operatorName: data.operatorName || 'Оператор техподдержки',
      accessLevel: normalizeAccessLevel(accessLevel),
      ended: false
    };
    sessionRef.current = s;
    setAccepting(true);
    setError('');

    try {
      // Главный процесс отдаёт экран только внутри подтверждённого сеанса и
      // сам спрашивает сотрудника в системном окне. Выбор здесь лишь
      // ограничивает, что там будет предложено; серверу уходит уровень,
      // выбранный в системном окне.
      const api = window.electronAPI;
      if (api?.rdSessionStart) {
        const consent = await api.rdSessionStart({
          sessionId: s.sessionId,
          operatorName: s.operatorName,
          accessLevel: s.accessLevel
        });
        if (s.ended) return;
        // Прежние версии приложения отвечали true/false.
        const accepted = consent === true || consent?.accepted === true;
        if (!accepted) {
          s.ended = true;
          sessionRef.current = null;
          // «busy» и «policy» оператору полезно знать: повторять запрос
          // бессмысленно. Остальные причины — просто отказ.
          const reason = consent?.reason;
          respond(s.sessionId, false, reason === 'busy' || reason === 'policy' ? { reason } : {});
          if (aliveRef.current) setAccepting(false);
          closeModal();
          return;
        }
        if (consent && typeof consent === 'object') s.accessLevel = normalizeAccessLevel(consent.accessLevel);
      }

      const stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE_CONSTRAINTS);
      if (s.ended) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      // Прямо говорим кодировщику, что это текст, а не видео: он перестаёт
      // размывать мелкие детали. Без этой строки удалённый экран нечитаем.
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.contentHint = 'text';
      streamRef.current = stream;

      // Ответ — первым. Пока сеанс не подтверждён, сервер остальные сообщения
      // сеанса не пересылает: раньше список мониторов уходил раньше ответа и
      // терялся.
      respond(s.sessionId, true, { accessLevel: s.accessLevel });
      setSession({ ...s });
      setAccepting(false);

      // Ввод разрешается ровно на время сеанса и только при полном доступе.
      if (s.accessLevel === 'full') await window.electronAPI?.rdInputEnable?.();
      if (s.ended) return;

      const pc = new RTCPeerConnection({ iceServers: getRdIceServers(iceServersRef.current) });
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // По умолчанию WebRTC при нехватке канала снижает РАЗРЕШЕНИЕ, удерживая
      // частоту кадров. Для рабочего стола нужно обратное: пусть лучше
      // подтормаживает, но текст остаётся читаемым. Плюс поднимаем потолок
      // битрейта — стандартных ~2.5 Мбит/с на экран 1080p не хватает.
      const sender = pc.getSenders().find((x) => x.track?.kind === 'video');
      if (sender) {
        const params = sender.getParameters();
        params.degradationPreference = 'maintain-resolution';
        params.encodings = [{ ...(params.encodings?.[0] || {}), maxBitrate: 8_000_000, maxFramerate: 20 }];
        try { await sender.setParameters(params); } catch (err) {
          console.warn('Не удалось поднять качество потока:', err);
        }
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendWs({ type: 'rd_ice_candidate', sessionId: s.sessionId, targetUserId: s.operatorId, candidate: e.candidate });
        }
      };

      // Соединение не установилось или оборвалось насовсем — сеанс закрывается
      // и у сотрудника: иначе захват экрана шёл бы в пустоту, а панель
      // «идёт сеанс» висела бы без оператора.
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        } else if (state === 'failed' || state === 'closed') {
          stopSession({ notify: true });
        }
      };
      connectTimerRef.current = setTimeout(() => {
        if (pcRef.current === pc && pc.connectionState !== 'connected') stopSession({ notify: true });
      }, RD_HOST_CONNECT_TIMEOUT_MS);

      const offer = await pc.createOffer();
      if (s.ended) return;
      await pc.setLocalDescription(offer);
      if (s.ended) return;
      sendWs({ type: 'rd_webrtc_offer', sessionId: s.sessionId, targetUserId: s.operatorId, sdp: offer });

      if (videoTrack) videoTrack.onended = () => stopSession();
      await sendScreens(s);
    } catch (err) {
      if (s.ended) return;
      if (answeredRef.current.has(s.sessionId)) {
        console.error('RD: сеанс прерван:', err);
        stopSession({ notify: true });
        return;
      }
      // Экран захватить не удалось — оператору отказ, сотруднику причина.
      // alert() здесь не годится: он останавливает всё окно, вместе с
      // перепиской и звонками.
      s.ended = true;
      sessionRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      window.electronAPI?.rdSessionEnd?.({ sessionId: s.sessionId });
      respond(s.sessionId, false, { reason: 'capture_failed' });
      if (aliveRef.current) {
        setAccepting(false);
        setError('Не удалось запустить трансляцию экрана: ' + (err?.message || err));
      }
    }
  };

  // Оператор выбрал другой монитор. Захватываем заново и подменяем дорожку в
  // уже установленном соединении — картинка не прерывается.
  const switchScreen = async (s, screenId) => {
    if (switchingRef.current) return;
    switchingRef.current = true;
    let next = null;
    let previousScreenId = null;
    try {
      const selected = await window.electronAPI?.rdSelectScreen?.(screenId);
      previousScreenId = selected?.previousScreenId ?? null;
      if (s.ended) return;

      next = await navigator.mediaDevices.getDisplayMedia(CAPTURE_CONSTRAINTS);
      const nextTrack = next.getVideoTracks()[0];
      const videoSender = pcRef.current?.getSenders().find((x) => x.track?.kind === 'video');
      if (s.ended || !nextTrack || !videoSender) throw new Error('сеанс завершён или нет видеодорожки');

      nextTrack.contentHint = 'text';
      await videoSender.replaceTrack(nextTrack);
      if (s.ended) throw new Error('сеанс завершён');

      const old = streamRef.current;
      streamRef.current = next;
      next = null;
      old?.getTracks().forEach((t) => t.stop());
      nextTrack.onended = () => stopSession();
    } catch (err) {
      // Новый захват не пригодился — останавливаем его, иначе он так и
      // остался бы запущенным: индикатор записи экрана и лишняя нагрузка.
      next?.getTracks().forEach((t) => t.stop());
      if (!s.ended) {
        console.warn('RD: не удалось переключить монитор:', err?.message || err);
        // Оператор по-прежнему видит прежний монитор — туда же и ввод.
        if (previousScreenId) window.electronAPI?.rdSelectScreen?.(previousScreenId, { restore: true });
      }
    } finally {
      switchingRef.current = false;
    }
  };

  const saveFile = (msg) => {
    // Файл от оператора кладётся в «Загрузки» и ничем не запускается —
    // решение открыть его остаётся за сотрудником.
    // Перед записью главный процесс спрашивает сотрудника в системном окне;
    // исполняемые файлы сохраняются с добавочным «.txt».
    if (!window.electronAPI?.rdSaveFile || typeof msg.data !== 'string') return;
    let bytes;
    try {
      const binary = atob(msg.data);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch (err) {
      console.warn('RD: файл не сохранён:', err?.message || err);
      return;
    }
    Promise.resolve(window.electronAPI.rdSaveFile({ fileName: msg.fileName, data: bytes }))
      .then((result) => {
        if (!aliveRef.current || !result) return;
        if (result.success && result.renamed) {
          setNotice(`Исполняемый файл сохранён как «${result.name}» — запускать его не стоит, если вы его не ждали`);
        } else if (!result.success && !result.declined && result.error) {
          setNotice(`Файл не сохранён: ${result.error}`);
        }
      })
      .catch((err) => console.warn('RD: файл не сохранён:', err?.message || err));
  };

  const sendClipboardMode = (s, enabled, extra = {}) =>
    sendWs({ type: 'rd_clipboard_mode', sessionId: s.sessionId, targetUserId: s.operatorId, enabled, ...extra });

  // Общий буфер включает сотрудник, а не оператор. То, что уже лежит в буфере
  // (скопированный пароль, номер договора), не отправляется: уходит только
  // скопированное после согласия.
  const allowClipboard = async () => {
    const s = sessionRef.current;
    if (!s || s.ended || s.accessLevel !== 'full') return;
    // Согласие фиксирует главный процесс — через системное окно. Без него
    // чтение буфера возвращает пустоту, что бы ни решила страница.
    const api = window.electronAPI;
    if (api?.rdClipboardGrant) {
      let granted = false;
      try {
        granted = await api.rdClipboardGrant({ role: 'host', sessionId: s.sessionId });
      } catch {}
      if (sessionRef.current !== s || s.ended) return;
      if (!granted) {
        declineClipboard();
        return;
      }
    }
    const watcher = new ClipboardWatcher({
      read: () => window.electronAPI?.rdClipboardRead?.({ role: 'host', sessionId: s.sessionId }),
      send: (text) => sendWs({ type: 'rd_clipboard', sessionId: s.sessionId, targetUserId: s.operatorId, text })
    });
    await watcher.prime();
    if (sessionRef.current !== s || s.ended) return;
    watcherRef.current = watcher;
    clipboardAllowedRef.current = true;
    setClipboardAllowed(true);
    setClipboardRequested(false);
    sendClipboardMode(s, true);
  };

  const declineClipboard = () => {
    const s = sessionRef.current;
    setClipboardRequested(false);
    if (s) sendClipboardMode(s, false, { declined: true });
  };

  const disableClipboard = ({ notify }) => {
    const s = sessionRef.current;
    if (s) window.electronAPI?.rdClipboardRevoke?.({ role: 'host', sessionId: s.sessionId });
    watcherRef.current = null;
    clipboardAllowedRef.current = false;
    setClipboardAllowed(false);
    setClipboardRequested(false);
    if (notify && s) sendClipboardMode(s, false);
  };

  const handleMessage = async (msg) => {
    const s = sessionRef.current;

    // Сеанса ещё нет: оператор мог отменить запрос, пока сотрудник думал.
    if (!s) {
      const prompt = promptRef.current;
      if (msg.type === 'rd_end' && prompt?.sessionId && msg.sessionId === prompt.sessionId) {
        answeredRef.current.add(prompt.sessionId);
        closeModal();
      }
      return;
    }

    if (msg.sessionId !== s.sessionId) return;
    if (!isHostMessageAllowed(msg.type, {
      active: !s.ended,
      accessLevel: s.accessLevel,
      clipboardAllowed: clipboardAllowedRef.current
    })) return;

    switch (msg.type) {
      case 'rd_end':
        stopSession({ notify: false });
        return;

      case 'rd_webrtc_answer': {
        const pc = pcRef.current;
        if (pc && pc.signalingState === 'have-local-offer' && msg.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
        return;
      }

      case 'rd_ice_candidate': {
        const pc = pcRef.current;
        if (!pc || !msg.candidate) return;
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (err) {
          console.warn('RD: кандидат отклонён', err?.message);
        }
        return;
      }

      case 'rd_input_event':
        window.electronAPI?.rdInputEvent?.(msg.event);
        return;

      case 'rd_select_screen':
        if (typeof msg.screenId === 'string') switchScreen(s, msg.screenId);
        return;

      case 'rd_clipboard':
        // Оператор скопировал текст у себя — кладём его в буфер сотрудника.
        if (typeof msg.text !== 'string') return;
        watcherRef.current?.remember(msg.text);
        await window.electronAPI?.rdClipboardWrite?.(msg.text, { role: 'host', sessionId: s.sessionId });
        return;

      case 'rd_clipboard_mode':
        if (!msg.enabled) disableClipboard({ notify: false });
        else if (clipboardAllowedRef.current) sendClipboardMode(s, true);
        else setClipboardRequested(true);
        return;

      case 'rd_file':
        saveFile(msg);
        return;

      default:
        return;
    }
  };

  // Связь с сервером оборвалась. Сервер в этом случае сам завершает сеанс и
  // сообщает оператору, а запрос, пришедший по старому соединению, уже
  // недействителен.
  const handleConnectionLost = () => {
    if (sessionRef.current) {
      stopSession({ notify: false });
      return;
    }
    const prompt = promptRef.current;
    if (prompt?.sessionId && !answeredRef.current.has(prompt.sessionId)) {
      answeredRef.current.add(prompt.sessionId);
      closeModal();
    }
  };

  // Слушатель сокета снимается при закрытии и переходит на новый сокет после
  // переподключения. Раньше он добавлялся при каждом «Разрешить» и не
  // снимался никогда, а после сеанса продолжал сохранять файлы и
  // переключать мониторы.
  useEffect(() => {
    if (!wsClient) return;
    const previous = wsRef.current;
    wsRef.current = wsClient;
    if (previous && previous !== wsClient) handleConnectionLost();

    const onMessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !msg.type.startsWith('rd_')) return;

      // Ответ и кандидаты обрабатываются строго по порядку: кандидат,
      // добавленный раньше ответа, отклоняется и теряется насовсем.
      if (SIGNALING_TYPES.has(msg.type)) {
        signalingQueueRef.current = signalingQueueRef.current
          .then(() => handleMessage(msg))
          .catch((err) => console.error('RD signaling error:', err));
      } else {
        handleMessage(msg).catch((err) => console.error('RD message error:', err));
      }
    };

    wsClient.addEventListener('message', onMessage);
    wsClient.addEventListener('close', handleConnectionLost);
    return () => {
      wsClient.removeEventListener('message', onMessage);
      wsClient.removeEventListener('close', handleConnectionLost);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsClient]);

  // Второй запрос, пока идёт сеанс, отклоняется сам: два оператора на одном
  // экране — не то, на что сотрудник соглашался. Новый запрос поверх
  // неотвеченного тоже закрывает прежний, иначе тот висел бы без ответа.
  useEffect(() => {
    const incoming = data.sessionId;
    if (!incoming) return;
    const previousPrompt = lastPromptRef.current;
    lastPromptRef.current = data;
    const s = sessionRef.current;

    if (s && incoming !== s.sessionId) {
      respond(incoming, false, { reason: 'busy' });
      setNotice(`Отклонён запрос от ${data.operatorName || 'другого сотрудника'}: уже идёт сеанс`);
      return;
    }
    if (!s && previousPrompt?.sessionId && previousPrompt.sessionId !== incoming) {
      respond(previousPrompt.sessionId, false, { reason: 'superseded' });
      setError('');
      setAccepting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.sessionId]);

  // Обратная сторона синхронизации: то, что сотрудник копирует у себя,
  // становится доступно оператору. Опрос — единственный способ: события
  // изменения буфера в Windows приложению не приходят.
  useEffect(() => {
    if (!session || !clipboardAllowed) return;
    const id = setInterval(() => { watcherRef.current?.tick(); }, CLIPBOARD_POLL_MS);
    return () => clearInterval(id);
  }, [session, clipboardAllowed]);

  // Аварийная клавиша, плашка поверх окон или пункт в трее обрывают управление
  // в главном процессе; здесь остаётся закрыть сам сеанс, чтобы оператор не
  // смотрел в замерший экран.
  useEffect(() => {
    const off = window.electronAPI?.onRdInputRevoked?.(() => {
      if (sessionRef.current) stopSession({ notify: true });
    });
    return typeof off === 'function' ? off : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Компонент убрали посреди сеанса (выход из учётной записи и т. п.) —
  // трансляция и управление не должны пережить его.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (sessionRef.current) stopSession({ notify: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReject = () => {
    if (accepting || sessionRef.current) return;
    respond(data.sessionId, false);
    closeModal();
  };

  if (session) {
    return (
      <div className="rd-host-floating-bar">
        <div className="rd-host-bar-content">
          <span className="rd-pulse-dot">●</span>
          <span className="rd-bar-title">Идет сеанс удаленного доступа:</span>
          <strong>{session.operatorName}</strong>
          <span className="rd-bar-mode-badge">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name={session.accessLevel === 'full' ? 'pointer' : 'eye'} size={14} />
              {session.accessLevel === 'full' ? 'Полный доступ (управление)' : 'Только просмотр'}
            </span>
          </span>
          <button className="rd-stop-btn" onClick={() => stopSession({ notify: true })}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="stop" size={14} />Завершить доступ</span>
          </button>
          {clipboardAllowed && (
            <>
              <span className="rd-bar-mode-badge" title="Скопированный текст передаётся между компьютерами">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="clipboard" size={14} />Буфер обмена общий</span>
              </span>
              <button className="rd-stop-btn" onClick={() => disableClipboard({ notify: true })}>
                Выключить общий буфер
              </button>
            </>
          )}
          {clipboardRequested && !clipboardAllowed && (
            <>
              <span className="rd-bar-hint">
                Оператор просит общий буфер обмена: скопированный с этого момента текст будет передаваться между компьютерами.
              </span>
              <button className="rd-stop-btn" onClick={allowClipboard}>Разрешить</button>
              <button className="rd-stop-btn" onClick={declineClipboard}>Не разрешать</button>
            </>
          )}
          {session.accessLevel === 'full' && (
            <span className="rd-bar-hint">Экстренно прервать: Ctrl+Alt+Shift+S</span>
          )}
          {notice && (
            <span className="rd-bar-hint" title="Скрыть" style={{ cursor: 'pointer' }} onClick={() => setNotice('')}>
              {notice} <Icon name="x" size={12} />
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={handleReject}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <div className="modal-header" style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-strong)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icon name="monitor" size={18} />
            <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-main)' }}>
              Запрос на удаленный рабочий стол
            </span>
          </div>
          <button className="btn-close-modal" onClick={handleReject} disabled={accepting} aria-label="Закрыть"><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: '24px 20px' }}>
          <div className="rd-operator-card">
            <div className="rd-operator-avatar">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" style={{ stroke: "var(--accent-text)" }} strokeWidth="1.8">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
            </div>
            <div className="rd-operator-info">
              <div className="rd-operator-name">{data.operatorName || 'Сотрудник техподдержки'}</div>
              <div className="rd-operator-role">{data.operatorJobTitle || 'Системный администратор'}</div>
              <div className="rd-operator-dept">АО СК "Сентрас Иншуранс"</div>
            </div>
          </div>

          <p style={{ fontSize: '13px', color: 'var(--text-main)', lineHeight: '1.5', margin: '16px 0 14px' }}>
            Коллега запрашивает подключение к вашему компьютеру для оказания помощи или демонстрации экрана.
          </p>

          {error ? (
            <div className="rd-security-notice" role="alert" style={{ color: 'var(--danger-text)' }}>
              {error}
            </div>
          ) : (
            <>
              <div className="rd-permission-box">
                <label className={'rd-perm-option ' + (accessLevel === 'view_only' ? 'selected' : '')}>
                  <input
                    type="radio"
                    name="accessLevel"
                    value="view_only"
                    checked={accessLevel === 'view_only'}
                    disabled={accepting}
                    onChange={() => setAccessLevel('view_only')}
                  />
                  <div className="rd-perm-text">
                    <strong>Только просмотр</strong>
                    <span>Коллега сможет только видеть экран: без управления, файлов и буфера обмена.</span>
                  </div>
                </label>

                <label className={'rd-perm-option ' + (accessLevel === 'full' ? 'selected' : '')}>
                  <input
                    type="radio"
                    name="accessLevel"
                    value="full"
                    checked={accessLevel === 'full'}
                    disabled={accepting}
                    onChange={() => setAccessLevel('full')}
                  />
                  <div className="rd-perm-text">
                    <strong>Полный доступ (управление)</strong>
                    <span>Разрешить просмотр экрана, управление курсором мыши и клавиатурой, передачу файлов.</span>
                  </div>
                </label>
              </div>

              <div className="rd-security-notice">
                <Icon name="lock" size={14} /> После «Разрешить доступ» Windows ещё раз спросит, какой доступ дать. Прервать сеанс можно в любой момент кнопкой «Завершить доступ».
              </div>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ background: 'var(--bg-panel)', padding: '12px 20px', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          {error ? (
            <button type="button" className="btn btn-secondary" onClick={closeModal}>
              Закрыть
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" onClick={handleReject} disabled={accepting}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="x" size={14} />Отклонить</span>
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: 'var(--success-fill)', borderColor: 'var(--success-fill)', fontWeight: 600 }}
                onClick={handleAccept}
                disabled={accepting}
              >
                {accepting ? 'Подтвердите в системном окне…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={14} />Разрешить доступ</span>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
