import React, { useId } from 'react';

// Знак CentyChat — тот же, что на значке приложения (desktop/build/icon.png):
// скруглённый квадрат с фирменным переходом «Сентрас» от орхидеи через
// фиолетовый и лазурь к бирюзе и белая буква «c» внутри.
//
// Геометрия «c» взята из RenderPinnacleIcons.cs (CreateExactCentrasC):
// ширина 0,58 высоты, толщина штриха 0,138, внешний радиус 0,28. Буква
// сдвинута вправо на 12 % своей ширины — оптическая середина открытой буквы
// правее геометрической. Координаты ниже — в системе квадрата 880×880 из
// исходника (высота буквы 500).
export const BRAND_C_PATH =
  'M619.8 190H469.8A140 140 0 0 0 329.8 330V550A140 140 0 0 0 469.8 690H619.8V621H469.8' +
  'A71 71 0 0 1 398.8 550V330A71 71 0 0 1 469.8 259H619.8Z';

const STOPS = [
  ['0', '#ec8ee0'],
  ['0.2', '#c078ee'],
  ['0.45', '#7c44ea'],
  ['0.75', '#2a72ee'],
  ['1', '#00daff']
];

export function BrandMark({ size = 28, title, className = '' }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fillId = `brand-fill-${uid}`;
  const rimId = `brand-rim-${uid}`;
  const labelled = Boolean(title);
  return (
    <svg
      className={`brand-mark ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 880 880"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : 'true'}
      focusable="false"
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="880" y2="880" gradientUnits="userSpaceOnUse">
          {STOPS.map(([offset, color]) => (
            <stop key={offset} offset={offset} stopColor={color} />
          ))}
        </linearGradient>
        <linearGradient id={rimId} x1="0" y1="0" x2="880" y2="880" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <rect width="880" height="880" rx="205" fill={`url(#${fillId})`} />
      <rect x="6" y="6" width="868" height="868" rx="199" fill="none" stroke={`url(#${rimId})`} strokeWidth="12" />
      <path d={BRAND_C_PATH} fill="#ffffff" />
    </svg>
  );
}

// Название приложения рядом со знаком. Надпись — обычный текст, а не
// картинка: её читают экранные дикторы и она следует теме.
export function BrandLockup({ size = 28, className = '', as: Tag = 'span' }) {
  return (
    <Tag className={`brand-lockup ${className}`.trim()}>
      <BrandMark size={size} />
      <span className="brand-wordmark">
        Centy<span className="brand-wordmark-accent">Chat</span>
      </span>
    </Tag>
  );
}

export default BrandMark;
