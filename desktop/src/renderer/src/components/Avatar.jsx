import React, { useState } from 'react';
import { avatarColor, avatarSrc, initialsOf } from '../lib/avatar.mjs';

// Один аватар на всё приложение: фотография, а если её нет или она не
// загрузилась — инициалы на постоянном для человека цвете. Раньше битая
// ссылка на фото показывалась значком «сломанной картинки».
export default function Avatar({ name, src: rawSrc, size = 36, shape = 'circle', className = '' }) {
  // Адрес, который <img> загрузить не сможет (см. avatarSrc), — сразу инициалы.
  const src = avatarSrc(rawSrc);
  // Запоминается адрес, который не загрузился, а не просто «ошибка»: сброс
  // через эффект срабатывал уже после мгновенной ошибки битой ссылки, и
  // значок сломанной картинки возвращался.
  const [failedSrc, setFailedSrc] = useState(null);
  const failed = Boolean(src) && failedSrc === src;

  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  const classes = `ui-avatar ${shape === 'square' ? 'is-square' : ''} ${className}`;

  if (src && !failed) {
    return (
      <span className={classes} style={style}>
        <img src={src} alt="" onError={() => setFailedSrc(src)} />
      </span>
    );
  }

  return (
    <span className={classes} style={{ ...style, backgroundColor: avatarColor(name) }} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
