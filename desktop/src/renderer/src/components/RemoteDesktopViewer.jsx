import React, { useState, useEffect, useRef, useCallback } from 'react';
import Icon from './Icon';
import { pointToFrame, MoveThrottle } from '../lib/remote-pointer.mjs';
import { keyEventToInput } from '../lib/remote-keyboard.mjs';
import { getRdIceServers, RD_CONNECT_TIMEOUT_MS } from '../lib/rd-config.mjs';
import { normalizeAccessLevel, createEndGuard, ClipboardWatcher } from '../lib/rd-session.mjs';

const CONNECT_TIMEOUT_TEXT =
  `Не удалось установить соединение за ${Math.round(RD_CONNECT_TIMEOUT_MS / 1000)} секунд. ` +
  'Скорее всего, прямое соединение между компьютерами блокирует сеть или VPN: попробуйте отключить VPN ' +
  'у себя или у сотрудника либо подключиться из одной сети. Если не помогает — обратитесь к администратору.';
const CONNECTION_FAILED_TEXT =
  'Соединение с компьютером сотрудника потеряно. Проверьте сеть или VPN и запросите доступ заново.';
const SERVER_LOST_TEXT =
  'Связь с сервером прервалась, и сеанс завершён. Запросите доступ заново.';

// accessLevel — уровень доступа, который выбрал сотрудник (App передаёт
// event.accessLevel из rd_response). Пока он не известен, окно работает как
// «только просмотр»: показывать управление, которого нет, хуже, чем на
// секунду его не показать. Сотрудник дополнительно сообщает уровень вместе со
// списком мониторов (rd_screens).
export default function RemoteDesktopViewer({ sessionId, targetUser, wsClient, pendingOffer, pendingCandidates, onEndSession, accessLevel: accessLevelProp }) {
  const [scaleMode, setScaleMode] = useState('fit');
  const [remoteStream, setRemoteStream] = useState(null);
  const [statusText, setStatusText] = useState('Устанавливаем соединение с экраном сотрудника…');
  const [accessLevel, setAccessLevel] = useState(normalizeAccessLevel(accessLevelProp));
  const [isRejected, setIsRejected] = useState(false);
  const [failure, setFailure] = useState(null);

  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [transferState, setTransferState] = useState(null);
  const [screens, setScreens] = useState([]);
  const [activeScreenId, setActiveScreenId] = useState(null);
  const [clipboardState, setClipboardState] = useState('off'); // off | pending | on
  const [linkStats, setLinkStats] = useState(null);

  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const moveThrottleRef = useRef(new MoveThrottle({ intervalMs: 33 }));
  const wsRef = useRef(wsClient);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const targetUserRef = useRef(targetUser);
  targetUserRef.current = targetUser;
  const handlersRef = useRef(null);
  const connectedRef = useRef(false);
  const clipboardStateRef = useRef('off');
  const canControlRef = useRef(false);
  const watcherRef = useRef(null);
  const liveTokenRef = useRef(null);

  // Обработчик завершения приходит из App новой функцией на каждую его
  // перерисовку — а перерисовывается App на каждое входящее сообщение. Держать
  // такую функцию среди зависимостей соединения значило пересоздавать
  // RTCPeerConnection по десять раз в минуту: картинка не успевала появиться.
  const onEndSessionRef = useRef(onEndSession);
  useEffect(() => { onEndSessionRef.current = onEndSession; }, [onEndSession]);

  useEffect(() => {
    if (accessLevelProp !== undefined) setAccessLevel(normalizeAccessLevel(accessLevelProp));
  }, [accessLevelProp]);

  useEffect(() => { clipboardStateRef.current = clipboardState; }, [clipboardState]);

  const sendWs = (payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...payload, targetUserId: targetUserRef.current?.id }));
      return true;
    }
    return false;
  };

  // rd_end уходит ровно один раз на сеанс — с кнопки, при закрытии окна или
  // при сбое соединения. Раньше оператор закрывал окно молча: сотрудник
  // продолжал транслировать экран и оставался под управлением.
  const endGuardRef = useRef(null);
  if (!endGuardRef.current) {
    endGuardRef.current = createEndGuard((sid) => sendWs({ type: 'rd_end', sessionId: sid }));
  }

  const endSession = () => {
    endGuardRef.current.end(sessionIdRef.current);
    onEndSessionRef.current?.();
  };

  // Сеанс не состоялся или оборвался: причина остаётся на экране, пока
  // оператор её не прочитает и не закроет окно сам.
  const failSession = (message, { notify = true } = {}) => {
    if (notify) endGuardRef.current.end(sessionIdRef.current);
    else endGuardRef.current.mark(sessionIdRef.current);
    watcherRef.current = null;
    setClipboardState('off');
    setRemoteStream(null);
    setFailure((prev) => prev || message);
  };

  // Закрытие окна (размонтирование) завершает сеанс. Проверка — на следующем
  // витке: StrictMode в разработке снимает и тут же заново подключает эффект,
  // и завершать сеанс от этого нельзя.
  useEffect(() => {
    const token = { sessionId, disposed: false };
    liveTokenRef.current = token;
    return () => {
      token.disposed = true;
      setTimeout(() => {
        const current = liveTokenRef.current;
        if (current && current !== token && current.sessionId === token.sessionId && !current.disposed) return;
        endGuardRef.current.end(token.sessionId);
      }, 0);
    };
  }, [sessionId]);

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

  // Соединение живёт столько же, сколько сеанс, — и НЕ пересоздаётся при
  // смене сокета. Раньше переподключение к серверу строило соединение заново
  // и отвечало на давно устаревшее предложение, сохранённое в App.
  useEffect(() => {
    connectedRef.current = false;
    setFailure(null);
    const pc = new RTCPeerConnection({ iceServers: getRdIceServers() });
    peerConnectionRef.current = pc;

    // Кандидаты нередко приходят раньше описания соединения. Добавить их в
    // этот момент нельзя — вызов бросает исключение, и кандидат теряется
    // насовсем. Потерянный кандидат означает несостоявшееся соединение, а
    // выглядит это как «висит на подключении».
    let remoteDescriptionSet = false;
    const pendingCandidates = [];
    let lastOfferSdp = null;
    // Предложение и кандидаты обрабатываются строго по очереди.
    let queue = Promise.resolve();
    const enqueue = (task) => {
      queue = queue.then(task).catch((err) => console.warn('RD:', err?.message || err));
    };

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
      const state = pc.connectionState;
      if (state === 'connected') {
        connectedRef.current = true;
        setStatusText('Подключено');
      } else if (state === 'disconnected') {
        setStatusText('Связь прервалась, восстанавливаем…');
      } else if (state === 'failed') {
        failSession(CONNECTION_FAILED_TEXT);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({ type: 'rd_ice_candidate', sessionId, candidate: event.candidate });
      }
    };

    // Одно и то же предложение приходит дважды: сохранённым в App (пришло до
    // появления окна) и через живой обработчик. Отвечать дважды на одно
    // предложение нельзя — повтор узнаётся по самому описанию.
    const answerOffer = async (sdp) => {
      if (!sdp || typeof sdp.sdp !== 'string' || sdp.sdp === lastOfferSdp) return;
      lastOfferSdp = sdp.sdp;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      remoteDescriptionSet = true;

      // Кандидаты, пришедшие до описания, добавляются теперь — иначе они бы
      // так и остались невостребованными.
      while (pendingCandidates.length) {
        await addCandidate(pendingCandidates.shift());
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ type: 'rd_webrtc_answer', sessionId, sdp: answer });
    };

    handlersRef.current = {
      offer: (sdp) => enqueue(() => answerOffer(sdp)),
      candidate: (candidate) => enqueue(() => addCandidate(candidate))
    };

    // Картинки нет слишком долго — оператору говорят причину, а не крутят
    // заставку бесконечно.
    const timer = setTimeout(() => {
      if (!connectedRef.current && pc.connectionState !== 'connected') failSession(CONNECT_TIMEOUT_TEXT);
    }, RD_CONNECT_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
      handlersRef.current = null;
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      if (peerConnectionRef.current === pc) peerConnectionRef.current = null;
    };
    // targetUser.id, а не сам объект: объект приходит новым на каждой
    // перерисовке App и пересоздавал бы соединение вместе с картинкой.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, targetUser.id]);

  // Предложение, сохранённое в App до появления окна.
  useEffect(() => {
    if (pendingOffer && pendingOffer.sessionId === sessionId) handlersRef.current?.offer(pendingOffer.sdp);
  }, [pendingOffer, sessionId]);

  // Кандидаты, пришедшие до появления окна (их придержал App). Каждый
  // передаётся один раз; до описания соединения они встают в ту же очередь.
  const deliveredCandidatesRef = useRef(0);
  useEffect(() => {
    if (!pendingCandidates || pendingCandidates.sessionId !== sessionId) return;
    const list = pendingCandidates.list || [];
    for (let i = deliveredCandidatesRef.current; i < list.length; i += 1) {
      handlersRef.current?.candidate(list[i]);
    }
    deliveredCandidatesRef.current = list.length;
  }, [pendingCandidates, sessionId]);

  const handleWsMessage = (msg) => {
    if (msg.sessionId !== sessionIdRef.current) return;

    switch (msg.type) {
      case 'rd_response':
        if (!msg.accepted) {
          setIsRejected(true);
          setStatusText('Сотрудник отклонил запрос на удаленный доступ.');
        } else {
          setStatusText('Сотрудник разрешил доступ. Запускаем трансляцию экрана…');
          if (msg.accessLevel) setAccessLevel(normalizeAccessLevel(msg.accessLevel));
        }
        return;

      case 'rd_webrtc_offer':
        handlersRef.current?.offer(msg.sdp);
        return;

      case 'rd_ice_candidate':
        if (msg.candidate) handlersRef.current?.candidate(msg.candidate);
        return;

      case 'rd_screens': {
        const list = Array.isArray(msg.screens) ? msg.screens : [];
        setScreens(list);
        setActiveScreenId((prev) => prev || list[0]?.id || null);
        if (msg.accessLevel) setAccessLevel(normalizeAccessLevel(msg.accessLevel));
        return;
      }

      case 'rd_clipboard':
        // Сотрудник скопировал текст у себя — кладём его в буфер оператора.
        if (clipboardStateRef.current === 'on' && typeof msg.text === 'string') {
          watcherRef.current?.remember(msg.text);
          window.electronAPI?.rdClipboardWrite?.(msg.text, { role: 'operator', sessionId: sessionIdRef.current });
        }
        return;

      case 'rd_clipboard_mode':
        // Решение об общем буфере принимает сотрудник — но только в ответ на
        // просьбу оператора и только при полном доступе. Раньше «включено» от
        // сотрудника принималось в любой момент, и буфер оператора начинал
        // уходить на чужую машину без его ведома.
        if (msg.enabled) {
          if (clipboardStateRef.current === 'pending' && canControlRef.current) setClipboardState('on');
        } else {
          watcherRef.current = null;
          setClipboardState('off');
          if (msg.declined) setTransferState({ kind: 'error', text: 'Сотрудник не разрешил общий буфер обмена' });
        }
        return;

      case 'rd_end': {
        // alert() останавливает всё окно: пока его не закроют, не идут ни
        // сообщения, ни звонки. Для сообщения о завершении сеанса это
        // чрезмерно — показываем его в самом окне сеанса.
        endGuardRef.current.mark(msg.sessionId);
        const reason = typeof msg.reason === 'string' && /[а-яё]/i.test(msg.reason) ? msg.reason : null;
        setStatusText(reason || (msg.fromUserId ? 'Сеанс завершён сотрудником.' : 'Сеанс завершён.'));
        setRemoteStream(null);
        watcherRef.current = null;
        setClipboardState('off');
        setTimeout(() => onEndSessionRef.current?.(), 1500);
        return;
      }

      default:
        return;
    }
  };

  // Слушатель сокета отдельно от соединения: при переподключении он
  // переезжает на новый сокет, а соединение с картинкой остаётся.
  useEffect(() => {
    if (!wsClient) return;
    const previous = wsRef.current;
    wsRef.current = wsClient;

    // Сервер завершает сеанс, когда у участника обрывается связь, — новый
    // сокет его уже не вернёт.
    const onConnectionLost = () => {
      if (endGuardRef.current.isEnded(sessionIdRef.current)) return;
      failSession(SERVER_LOST_TEXT, { notify: false });
    };
    if (previous && previous !== wsClient) onConnectionLost();

    const onMessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try {
        handleWsMessage(msg);
      } catch (err) {
        console.error('RD message error:', err);
      }
    };

    wsClient.addEventListener('message', onMessage);
    wsClient.addEventListener('close', onConnectionLost);
    return () => {
      wsClient.removeEventListener('message', onMessage);
      wsClient.removeEventListener('close', onConnectionLost);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsClient]);

  const canControl = accessLevel === 'full' && !failure;
  canControlRef.current = canControl;

  const sendInputEvent = useCallback((inputEvent) => {
    if (!canControl) return;
    sendWs({ type: 'rd_input_event', sessionId, event: inputEvent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canControl, sessionId]);

  // Передача файла на машину сотрудника. Идёт по тому же каналу сеанса, что и
  // сигнализация: сервер уже проверяет, что оба участника подтвердили сеанс,
  // и не нужен ни отдельный маршрут, ни прямое соединение (оно может не
  // установиться за строгим NAT). Ограничение по размеру — чтобы одно
  // сообщение не забило канал: сеанс идёт по нему же.
  const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;

  // Общий буфер включается только с согласия сотрудника: оператор просит,
  // сотрудник разрешает у себя в панели сеанса.
  const toggleClipboardSync = async () => {
    if (!canControl) return;
    if (clipboardState === 'off') {
      // Свой буфер оператор отдаёт тоже только с согласия в системном окне:
      // без него главный процесс чтение буфера не выполнит.
      const api = window.electronAPI;
      if (api?.rdClipboardGrant) {
        let granted = false;
        try {
          granted = await api.rdClipboardGrant({
            role: 'operator',
            sessionId,
            peerName: targetUserRef.current?.full_name || ''
          });
        } catch {}
        if (!granted || clipboardStateRef.current !== 'off' || !canControlRef.current) return;
      }
      if (sendWs({ type: 'rd_clipboard_mode', sessionId, enabled: true })) {
        setClipboardState('pending');
        setTransferState({ kind: 'progress', text: 'Ждём, пока сотрудник разрешит общий буфер обмена…' });
      } else {
        window.electronAPI?.rdClipboardRevoke?.({ role: 'operator', sessionId });
      }
    } else {
      watcherRef.current = null;
      setClipboardState('off');
      sendWs({ type: 'rd_clipboard_mode', sessionId, enabled: false });
    }
  };

  // Свой буфер опрашивается: событий об изменении Windows не присылает. Как и
  // у сотрудника, уходит только скопированное после включения.
  useEffect(() => {
    if (clipboardState !== 'on' || !canControl || !window.electronAPI?.rdClipboardRead) return;
    setTransferState(null);
    const watcher = new ClipboardWatcher({
      read: () => window.electronAPI.rdClipboardRead({ role: 'operator', sessionId }),
      send: (text) => sendWs({ type: 'rd_clipboard', sessionId, text })
    });
    watcherRef.current = watcher;
    watcher.prime();
    const id = setInterval(() => {
      if (watcherRef.current === watcher) watcher.tick();
    }, 1200);
    return () => {
      clearInterval(id);
      if (watcherRef.current === watcher) watcherRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipboardState, canControl, sessionId]);

  // Управление пропало (понижение до просмотра, сбой) — общий буфер тоже.
  useEffect(() => {
    if (!canControl && clipboardState !== 'off') {
      watcherRef.current = null;
      setClipboardState('off');
    }
  }, [canControl, clipboardState]);

  // Буфер выключен любым путём (оператор, отказ сотрудника, конец сеанса,
  // закрытие окна) — согласие в главном процессе снимается.
  useEffect(() => {
    if (clipboardState !== 'off') return undefined;
    window.electronAPI?.rdClipboardRevoke?.({ role: 'operator', sessionId });
    return undefined;
  }, [clipboardState, sessionId]);
  useEffect(() => () => {
    window.electronAPI?.rdClipboardRevoke?.({ role: 'operator', sessionId });
  }, [sessionId]);

  const switchScreen = (screenId) => {
    setActiveScreenId(screenId);
    sendWs({ type: 'rd_select_screen', sessionId, screenId });
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
    if (!canControl) return;
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
        const sent = sendWs({
          type: 'rd_file',
          sessionId,
          fileName: file.name,
          size: file.size,
          data: btoa(binary)
        });
        setTransferState(sent
          ? { kind: 'done', text: `«${file.name}» отправлен в папку «Загрузки» сотрудника` }
          : { kind: 'error', text: 'Нет связи с сервером' });
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

  // Печатный символ уходит текстом, сочетания — физической клавишей
  // (см. lib/remote-keyboard.mjs): Ctrl+C работает при любой раскладке.
  const handleKeyDown = (e) => {
    if (!canControl) return;
    e.preventDefault();
    const input = keyEventToInput(e);
    if (input) sendInputEvent(input);
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
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name={accessLevel === 'full' ? 'pointer' : 'eye'} size={14} />
              {accessLevel === 'full' ? 'Полный доступ' : 'Только просмотр'}
            </span>
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
              disabled={Boolean(failure)}
            >
              {screens.map((s, i) => (
                <option key={s.id} value={s.id}>{s.name || `Экран ${i + 1}`}</option>
              ))}
            </select>
          )}
          {canControl && (
            <>
              <button
                className={`rd-btn${clipboardState === 'on' ? ' active' : ''}`}
                title="Общий буфер обмена: скопированный после включения текст переносится между компьютерами. Включается с согласия сотрудника."
                disabled={!remoteStream}
                onClick={toggleClipboardSync}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="clipboard" size={14} />
                  {clipboardState === 'on' ? 'Буфер: общий' : clipboardState === 'pending' ? 'Буфер: ждём согласия' : 'Буфер'}
                </span>
              </button>
              <button
                className="rd-btn"
                title="Передать файл в папку «Загрузки» сотрудника"
                disabled={!remoteStream}
                onClick={handleSendFile}
              >
                Передать файл
              </button>
            </>
          )}
          <button
            className="rd-btn"
            onClick={() => setScaleMode(scaleMode === 'fit' ? 'original' : 'fit')}
          >
            {scaleMode === 'fit' ? 'Масштаб 1:1' : 'По размеру'}
          </button>
          <button className="rd-btn-danger" onClick={endSession}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="x" size={14} />Завершить сеанс</span>
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`rd-video-area${canControl ? ' controllable' : ''}${keyboardCaptured ? ' focused' : ''}`}
        tabIndex={canControl ? 0 : -1}
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
        {remoteStream && !failure ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={'rd-video-stream ' + (scaleMode === 'fit' ? 'fit' : 'original')}
          />
        ) : (
          <div className="rd-connecting-overlay">
            {failure ? (
              <div className="rd-rejected-box">
                <div style={{ marginBottom: '12px', color: 'light-dark(#f59e0b, #f4c77b)' }}><Icon name="alert" size={48} /></div>
                <h3 style={{ color: 'light-dark(#f59e0b, #f4c77b)', marginBottom: '8px' }}>Сеанс не удался</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px', maxWidth: '520px' }}>
                  {failure}
                </p>
                <button className="btn btn-secondary" onClick={endSession}>
                  Закрыть окно
                </button>
              </div>
            ) : isRejected ? (
              <div className="rd-rejected-box">
                <div style={{ marginBottom: '12px', color: '#ef4444' }}><Icon name="ban" size={48} /></div>
                <h3 style={{ color: '#ef4444', marginBottom: '8px' }}>Запрос отклонен</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                  Сотрудник {targetUser.full_name} отклонил запрос на удаленный рабочий стол.
                </p>
                <button className="btn btn-secondary" onClick={endSession}>
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
