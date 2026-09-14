import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { loadImage } from '../lib/image-cache';

// Просмотр картинки из переписки: целиком, по размеру окна, со стрелками к
// соседним картинкам этого чата. Фон всегда тёмный и днём — фото на светлом
// поле теряет контраст, так смотрят фото везде.
export default function ImageViewer({ images, index, serverUrl, token, onIndexChange, onClose, onDownload }) {
  const item = images[index];
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const closeRef = useRef(null);
  const returnFocusRef = useRef(document.activeElement);

  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setFailed(false);
    setActualSize(false);
    loadImage(item.fileId, { serverUrl, token })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [item.fileId, serverUrl, token]);

  useEffect(() => {
    closeRef.current?.focus();
    const returnTo = returnFocusRef.current;
    return () => returnTo?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1);
      else if (e.key === 'ArrowRight' && hasNext) onIndexChange(index + 1);
    };
    // Захват: Escape не должен заодно закрыть ответ или меню под просмотром.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, hasPrev, hasNext, onClose, onIndexChange]);

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={`Просмотр: ${item.name}`} onClick={onClose}>
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <div className="image-viewer-caption">
          <span className="image-viewer-name" title={item.name}>{item.name}</span>
          <span className="image-viewer-meta">
            {item.sender}{item.time ? ` · ${item.time}` : ''}{images.length > 1 ? ` · ${index + 1} из ${images.length}` : ''}
          </span>
        </div>
        <div className="image-viewer-actions">
          <button
            type="button"
            className="image-viewer-btn"
            onClick={() => setActualSize((v) => !v)}
            disabled={!src}
            aria-pressed={actualSize}
            title={actualSize ? 'Вписать в окно' : 'Настоящий размер'}
          >
            <Icon name={actualSize ? 'minimize' : 'maximize'} size={17} />
          </button>
          <button type="button" className="image-viewer-btn" onClick={() => onDownload(item)} title="Скачать">
            <Icon name="download" size={17} />
          </button>
          <button type="button" className="image-viewer-btn" ref={closeRef} onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
            <Icon name="x" size={18} />
          </button>
        </div>
      </div>

      <div className={`image-viewer-stage${actualSize ? ' is-actual' : ''}`}>
        {failed ? (
          <div className="image-viewer-state" onClick={(e) => e.stopPropagation()}>
            <Icon name="alert" size={22} />
            <span>Не удалось загрузить изображение</span>
          </div>
        ) : !src ? (
          <div className="image-viewer-state"><span className="chat-loading-spinner" /></div>
        ) : (
          <img
            key={src}
            src={src}
            alt={item.name}
            className="image-viewer-img"
            onClick={(e) => { e.stopPropagation(); setActualSize((v) => !v); }}
            draggable={false}
          />
        )}
      </div>

      {hasPrev && (
        <button
          type="button"
          className="image-viewer-nav is-prev"
          onClick={(e) => { e.stopPropagation(); onIndexChange(index - 1); }}
          aria-label="Предыдущее изображение"
        >
          <Icon name="chevronLeft" size={22} />
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          className="image-viewer-nav is-next"
          onClick={(e) => { e.stopPropagation(); onIndexChange(index + 1); }}
          aria-label="Следующее изображение"
        >
          <Icon name="chevronRight" size={22} />
        </button>
      )}
    </div>
  );
}
