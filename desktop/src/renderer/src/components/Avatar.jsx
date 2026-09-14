import React, { useEffect, useState } from 'react';
import { avatarColor, initialsOf } from '../lib/avatar.mjs';

// Один аватар на всё приложение: фотография, а если её нет или она не
// загрузилась — инициалы на постоянном для человека цвете. Раньше битая
// ссылка на фото показывалась значком «сломанной картинки».
export default function Avatar({ name, src, size = 36, shape = 'circle', className = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  const classes = `ui-avatar ${shape === 'square' ? 'is-square' : ''} ${className}`;

  if (src && !failed) {
    return (
      <span className={classes} style={style}>
        <img src={src} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }

  return (
    <span className={classes} style={{ ...style, backgroundColor: avatarColor(name) }} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
