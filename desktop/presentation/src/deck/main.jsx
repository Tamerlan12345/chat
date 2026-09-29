import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import fixtures from '../fixtures.json';
import { createMockServer } from './mock-server';
import { createHost, frameSrcDoc } from './host';
import { SLIDES } from './scenes.jsx';
import './deck.css';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Ключи mychat_* — те же ключи localStorage, что читает клиент; с
// переименованием в CentyChat они не менялись.
const ROLE_BOOT = {
  saparova: { storage: { mychat_token: fixtures.logins.saparova.token, mychat_server_url: 'https://chat.centras.local' } },
  akhmetov: { storage: { mychat_token: fixtures.logins.akhmetov.token, mychat_server_url: 'https://chat.centras.local' } },
  admin: { storage: { mychat_token: fixtures.logins.admin.token, mychat_server_url: 'https://chat.centras.local' } },
  guest: { storage: { mychat_server_url: 'https://chat.centras.local', mychat_logged_out: '1' } }
};

// Подставной сервер пересоздается на каждый прогон сцены, поэтому дек всегда
// начинает с одного и того же состояния.
let server = createMockServer(fixtures);
const host = createHost({
  http: (...a) => server.http(...a),
  upload: (...a) => server.upload(...a),
  connect: (...a) => server.connect(...a)
});

function AppWindow({ role, title, subtitle, theme, width, height, onReady }) {
  const ref = useRef(null);
  const idRef = useRef('w' + Math.random().toString(36).slice(2, 7));
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  // Регистрация окна — ровно один раз на его жизнь. Иначе перерисовка дека
  // закрывала уже установленное соединение приложения.
  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win) return undefined;
    const record = { id: idRef.current, sockets: new Map(), onReady: () => readyRef.current?.(win), latency: 90 };
    host.register(win, record);
    return () => host.unregister(win);
  }, []);

  const srcDoc = useMemo(() => frameSrcDoc({ ...ROLE_BOOT[role], role, theme: theme || 'light' }), [role, theme]);

  return (
    <div className="win" style={{ width, height }}>
      <div className="win-bar">
        <span className="win-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {title}
        </span>
        <span className="win-ctl"><i>–</i><i>▢</i><i className="x">✕</i></span>
      </div>
      <iframe ref={ref} srcDoc={srcDoc} title={title} className="win-frame" />
      {subtitle ? <div className="win-note">{subtitle}</div> : null}
    </div>
  );
}

function Stage({ slide, runKey, onFrames }) {
  const boxRef = useRef(null);
  const [scale, setScale] = useState(0.6);
  const framesRef = useRef({});
  const wins = slide.windows || [];
  const gap = 26;
  const totalW = wins.reduce((s, w) => s + (w.width || 1180), 0) + gap * Math.max(0, wins.length - 1);
  const totalH = Math.max(...wins.map((w) => w.height || 780), 1);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const fit = () => {
      const pad = 10;
      setScale(Math.min((el.clientWidth - pad) / totalW, (el.clientHeight - pad) / (totalH + 34), 1));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [totalW, totalH]);

  useEffect(() => { framesRef.current = {}; }, [runKey]);

  const onFramesRef = useRef(onFrames);
  onFramesRef.current = onFrames;
  const rolesRef = useRef(wins.map((w) => w.role));
  rolesRef.current = wins.map((w) => w.role);
  const ready = useCallback((role, win) => {
    framesRef.current[role] = win;
    if (rolesRef.current.every((r) => framesRef.current[r])) onFramesRef.current({ ...framesRef.current });
  }, []);

  return (
    <div className="stage" ref={boxRef}>
      <div className="stage-fit" style={{ width: totalW * scale, height: (totalH + 34) * scale }}>
      <div className="stage-inner" style={{ width: totalW, height: totalH + 34, transform: `scale(${scale})` }}>
        {wins.map((w) => (
          <AppWindow
            key={runKey + ':' + w.role}
            role={w.role}
            title={w.title}
            subtitle={w.subtitle}
            theme={slide.theme}
            width={w.width || 1180}
            height={w.height || 780}
            onReady={(win) => ready(w.role, win)}
          />
        ))}
      </div>
      </div>
    </div>
  );
}

function Deck() {
  const [index, setIndex] = useState(() => {
    const n = parseInt(String(location.hash).replace('#', ''), 10);
    return Number.isFinite(n) && n >= 1 && n <= SLIDES.length ? n - 1 : 0;
  });
  const [runKey, setRunKey] = useState(1);
  const [steps, setSteps] = useState([]);
  const [activeStep, setActiveStep] = useState(-1);
  const [phase, setPhase] = useState('idle'); // idle | playing | done | manual
  const abortRef = useRef({ cancelled: false });
  const slide = SLIDES[index];

  useEffect(() => { try { history.replaceState(null, '', '#' + (index + 1)); } catch {} }, [index]);

  const go = useCallback((i) => {
    const next = Math.max(0, Math.min(SLIDES.length - 1, i));
    abortRef.current.cancelled = true;
    setIndex(next);
    setRunKey((k) => k + 1);
    setSteps([]);
    setActiveStep(-1);
    setPhase('idle');
    server = createMockServer(fixtures);
  }, []);

  const replay = useCallback(() => {
    abortRef.current.cancelled = true;
    server = createMockServer(fixtures);
    setRunKey((k) => k + 1);
    setSteps([]);
    setActiveStep(-1);
    setPhase('idle');
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(index + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(index - 1); }
      if (e.key === 'Home') go(0);
      if (e.key === 'End') go(SLIDES.length - 1);
      if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') replay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index, replay]);

  const onFrames = useCallback(async (frames) => {
    if (!slide.script) { setPhase('manual'); return; }
    const token = { cancelled: false };
    abortRef.current = token;
    const list = [];
    setPhase('playing');
    const ctx = {
      wait: async (ms) => { await wait(ms); if (token.cancelled) throw new Error('отменено'); },
      step: (text) => {
        if (token.cancelled) throw new Error('отменено');
        list.push(text);
        setSteps([...list]);
        setActiveStep(list.length - 1);
      },
      cmd: async (role, cmd) => {
        if (token.cancelled) throw new Error('отменено');
        if (!frames[role]) throw new Error('нет окна ' + role);
        return host.command(frames[role], cmd);
      },
      srv: () => server,
      ids: {
        saparova: fixtures.logins.saparova.user.id,
        akhmetov: fixtures.logins.akhmetov.user.id,
        admin: fixtures.logins.admin.user.id
      }
    };
    try {
      await wait(700);
      await slide.script(ctx);
      if (!token.cancelled) { setActiveStep(-1); setPhase('done'); }
    } catch (err) {
      if (!token.cancelled) {
        console.warn('сцена прервана:', err);
        setPhase('done');
      }
    }
  }, [slide]);

  return (
    <div className="deck">
      <header className="top">
        <div className="brand">
          <i><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></i>
          CentyChat
        </div>
        <nav className="tabs">
          {SLIDES.map((s, i) => (
            <button key={s.id} className={i === index ? 'on' : ''} onClick={() => go(i)}>{s.tab}</button>
          ))}
        </nav>
        <span className="count">{index + 1} / {SLIDES.length}</span>
      </header>

      <div className={'body' + (slide.full ? ' full' : '')}>
        {slide.full ? null : (
        <aside className="side">
          <div className="kicker">{slide.kicker}</div>
          <h2>{slide.title}</h2>
          {slide.lead ? <p className="lead">{slide.lead}</p> : null}

          {slide.script ? (
            <div className="run">
              <div className="run-head">
                <span className={'dot ' + phase} />
                {phase === 'playing' ? 'Сценарий идет' : phase === 'done' ? 'Сценарий закончен, попробуйте сами' : phase === 'manual' ? 'Живое окно, попробуйте сами' : 'Готовим окно'}
                <button className="replay" onClick={replay}>Повторить</button>
              </div>
              <ol className="steps">
                {steps.map((t, i) => (
                  <li key={i} className={i === activeStep ? 'on' : 'past'}>
                    <span className="tick">{i === activeStep ? '•' : '✓'}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {slide.facts ? (
            <ul className="facts">
              {slide.facts.map((f, i) => <li key={i} dangerouslySetInnerHTML={{ __html: f }} />)}
            </ul>
          ) : null}

          {slide.note ? <div className="note" dangerouslySetInnerHTML={{ __html: slide.note }} /> : null}
        </aside>
        )}

        <main className="main">
          <button className="arrow left" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Предыдущий слайд">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          {slide.custom ? <slide.custom key={runKey} /> : <Stage slide={slide} runKey={runKey} onFrames={onFrames} />}
          <button className="arrow right" onClick={() => go(index + 1)} disabled={index === SLIDES.length - 1} aria-label="Следующий слайд">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
          </button>
        </main>
      </div>

      <footer className="nav">
        <button className="go" onClick={() => go(index - 1)} disabled={index === 0}>← Назад</button>
        <span className="hint">Стрелки листают, R повторяет сценарий. В окнах можно работать самому: писать, нажимать, открывать разделы.</span>
        <button className="go primary" onClick={() => go(index + 1)} disabled={index === SLIDES.length - 1}>Далее →</button>
      </footer>
    </div>
  );
}

// Для отладки сцен: window.__srv() возвращает текущий подставной сервер.
window.__srv = () => server;

ReactDOM.createRoot(document.getElementById('root')).render(<Deck />);
