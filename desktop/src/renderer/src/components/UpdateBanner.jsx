import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { bannerFor, resolveLegacyDownloadUrl } from '../lib/update-status.mjs';

// Баннер автообновления рядом со стопкой уведомлений (App.jsx). Данные —
// только из состояния главного процесса (Задача 9, desktop/src/main/updater.js);
// правила «что показать» разбираются в lib/update-status.mjs, здесь только
// подписка на IPC и сама разметка.

const TONE_ICON = { info: 'download', warn: 'alert', error: 'circleX' };

// У оболочки 1.0.0 (до автообновления) window.electronAPI существует, но в
// нём нет getUpdateState/onUpdateStatus — эти функции появились только в
// Задаче 9. Сам интерфейс (этот файл) приходит с сервера при каждом выкате и
// одинаков для всех, поэтому отличить старую оболочку можно только так.
function detectLegacyShell() {
  return Boolean(window.electronAPI) && typeof window.electronAPI.getUpdateState !== 'function';
}

const INSTALL_REFUSAL_TEXT = {
  busy: 'Установка уже идёт — подождите',
  'not-downloaded': 'Обновление ещё не готово к установке',
  'remote-session': 'Нельзя ставить обновление во время сеанса удалённого рабочего стола — попробуйте позже',
  'install-failed': 'Установщик не запустился — сообщите в ИТ-службу'
};

function installRefusalText(reason) {
  if (!reason) return 'Установка не началась';
  return INSTALL_REFUSAL_TEXT[reason] || `Установка не началась — сообщите в ИТ-службу (${reason})`;
}

export default function UpdateBanner({ serverUrl }) {
  const [legacyShell] = useState(detectLegacyShell);
  const [state, setState] = useState(null);
  const [legacyUrl, setLegacyUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // Оболочка Задачи 9 и новее: состояние приходит по IPC, обновляется живыми
  // событиями — без опроса.
  useEffect(() => {
    if (legacyShell || !window.electronAPI?.getUpdateState) return undefined;
    let cancelled = false;
    window.electronAPI.getUpdateState().then((s) => { if (!cancelled) setState(s); }).catch(() => {});
    const unsubscribe = window.electronAPI.onUpdateStatus?.((s) => setState(s));
    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [legacyShell]);

  // Старая оболочка сама проверять и ставить обновления не умеет — ссылку на
  // установщик берём напрямую из /updates/policy.json, как и главный процесс
  // (Задача 9) делает это для видов установки notify. setupUrl достраивается
  // и проверяется resolveLegacyDownloadUrl — сервер отдаёт его относительным,
  // но `new URL(x, base)` не трогает уже абсолютный x, а policy.json не
  // заслуживает доверия настолько, чтобы открывать присланную им ссылку без
  // проверки происхождения.
  useEffect(() => {
    if (!legacyShell) return undefined;
    let cancelled = false;
    fetch(`${serverUrl}/updates/policy.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((policy) => {
        if (cancelled || !policy?.setupUrl) return;
        setLegacyUrl(resolveLegacyDownloadUrl(policy.setupUrl, serverUrl));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [legacyShell, serverUrl]);

  const banner = bannerFor(state, { legacyShell });
  if (!banner) return null;

  const handleAction = async () => {
    if (!banner.action || busy) return;
    setNote('');
    if (banner.action.kind === 'install') {
      setBusy(true);
      try {
        const result = await window.electronAPI.installUpdate();
        if (!result?.ok) setNote(installRefusalText(result?.reason));
      } catch {
        setNote('Не удалось начать установку');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (banner.action.kind === 'download') {
      if (!legacyShell && window.electronAPI?.openUpdateDownload) {
        const opened = await window.electronAPI.openUpdateDownload().catch(() => false);
        if (!opened) setNote('Не удалось открыть ссылку на скачивание');
      } else if (legacyUrl) {
        window.open(legacyUrl, '_blank', 'noopener');
      } else {
        setNote('Ссылка на скачивание пока недоступна — попробуйте позже');
      }
    }
  };

  return (
    <div className={`update-banner is-${banner.tone}`} role={banner.tone === 'error' ? 'alert' : 'status'}>
      <span className="update-banner-icon"><Icon name={TONE_ICON[banner.tone] || 'download'} size={16} /></span>
      <span className="update-banner-text">{banner.text}</span>
      {banner.action && (
        <button type="button" className="update-banner-btn" onClick={handleAction} disabled={busy}>
          {busy ? 'Устанавливаем…' : banner.action.label}
        </button>
      )}
      {note && <span className="update-banner-note">{note}</span>}
    </div>
  );
}
