import React, { useState, useEffect, useRef, useMemo } from 'react';

const EMOJI_DATABASE = [
  // Часто используемые
  { emoji: '👍', name: 'палец вверх отлично да хорошо ок класс', cat: 'recent' },
  { emoji: '🤝', name: 'рукопожатие сделка согласен коллега партнер', cat: 'recent' },
  { emoji: '👌', name: 'ок отлично принято супер', cat: 'recent' },
  { emoji: '✅', name: 'галочка сделано готово выполнено ок', cat: 'recent' },
  { emoji: '❌', name: 'крестик ошибка отмена нет отклонено', cat: 'recent' },
  { emoji: '💡', name: 'идея лампочка мысль предложение', cat: 'recent' },
  { emoji: '📌', name: 'скрепка пин закрепить важно внимание', cat: 'recent' },
  { emoji: '📎', name: 'вложение скрепка файл прикрепить документ', cat: 'recent' },
  { emoji: '⚡', name: 'молния срочно скорость молниеносно важно', cat: 'recent' },
  { emoji: '☕', name: 'кофе перерыв чай отдых', cat: 'recent' },
  { emoji: '💻', name: 'ноутбук компьютер работа код разработка IT', cat: 'recent' },
  { emoji: '📊', name: 'диаграмма график отчет статистика показатели', cat: 'recent' },
  { emoji: '📈', name: 'рост график повышение успех тренд', cat: 'recent' },
  { emoji: '📄', name: 'документ страница файл договор отчет', cat: 'recent' },
  { emoji: '🔒', name: 'замок безопасность защита доступ закрыто', cat: 'recent' },
  { emoji: '🎯', name: 'мишень цель задача KPI точно в цель', cat: 'recent' },
  { emoji: '⏳', name: 'песочные часы ожидание время в процессе срок', cat: 'recent' },
  { emoji: '😊', name: 'улыбка радость позитив добро', cat: 'recent' },

  // Смайлы
  { emoji: '😀', name: 'улыбка лицо радость доволен', cat: 'smileys' },
  { emoji: '😃', name: 'смех улыбка глаза открыты', cat: 'smileys' },
  { emoji: '😄', name: 'смех улыбка прищур радость', cat: 'smileys' },
  { emoji: '😁', name: 'ухмылка зубы радость довольный', cat: 'smileys' },
  { emoji: '😆', name: 'хохот смех закрыты глаза', cat: 'smileys' },
  { emoji: '😅', name: 'пот неловко облегчение улыбка', cat: 'smileys' },
  { emoji: '😂', name: 'слезы от смеха ржач угар', cat: 'smileys' },
  { emoji: '🙂', name: 'спокойная улыбка нейтрально понятно', cat: 'smileys' },
  { emoji: '😉', name: 'подмигивание намек ок', cat: 'smileys' },
  { emoji: '😇', name: 'ангел нимб невинность святой', cat: 'smileys' },
  { emoji: '🧐', name: 'монокль анализ проверить изучаю', cat: 'smileys' },
  { emoji: '🤓', name: 'очки зануда умник эксперт IT спец', cat: 'smileys' },
  { emoji: '😎', name: 'круто очки профи молодец', cat: 'smileys' },
  { emoji: '🥳', name: 'праздник колпак поздравляю ура', cat: 'smileys' },
  { emoji: '😏', name: 'ухмылка хитрость подозрительно', cat: 'smileys' },
  { emoji: '😒', name: 'недоволен скука скептицизм', cat: 'smileys' },
  { emoji: '😞', name: 'грусть разочарование печаль', cat: 'smileys' },
  { emoji: '😔', name: 'задумчивость грусть печаль', cat: 'smileys' },
  { emoji: '😟', name: 'беспокойство тревога сомнение', cat: 'smileys' },
  { emoji: '😕', name: 'недоумение непонятно вопрос', cat: 'smileys' },
  { emoji: '🤔', name: 'думаю размышление вопрос гипотеза', cat: 'smileys' },
  { emoji: '🤫', name: 'тихо секрет молчи конфиденциально', cat: 'smileys' },
  { emoji: '🤭', name: 'ой хихикнул закрыл рот', cat: 'smileys' },
  { emoji: '🥱', name: 'зевок устал спать хочу поздно', cat: 'smileys' },
  { emoji: '😴', name: 'сон спит ночь отдых', cat: 'smileys' },
  { emoji: '😐', name: 'нейтрально без комментариев poker face', cat: 'smileys' },
  { emoji: '😑', name: 'без эмоций вздох усталость', cat: 'smileys' },
  { emoji: '😶', name: 'молчу без слов нет слов', cat: 'smileys' },
  { emoji: '😱', name: 'шок ужас испуг дедлайн аврал', cat: 'smileys' },
  { emoji: '🤯', name: 'взрыв мозга шок открытие невероятно', cat: 'smileys' },
  { emoji: '😳', name: 'смущение удивление опешил', cat: 'smileys' },

  // Жесты
  { emoji: '👎', name: 'палец вниз плохо не согласен дизлайк', cat: 'gestures' },
  { emoji: '👏', name: 'аплодисменты браво поздравляю молодец', cat: 'gestures' },
  { emoji: '🙌', name: 'ура ладони праздник победа', cat: 'gestures' },
  { emoji: '✊', name: 'кулак солидарность держись сила', cat: 'gestures' },
  { emoji: '👊', name: 'кулак привет удар бро', cat: 'gestures' },
  { emoji: '✋', name: 'стоп ладонь привет пауза', cat: 'gestures' },
  { emoji: '👋', name: 'привет пока помахать рукой', cat: 'gestures' },
  { emoji: '✌️', name: 'победа мир виктори два', cat: 'gestures' },
  { emoji: '🤞', name: 'скрещенные пальцы удачи надежда', cat: 'gestures' },
  { emoji: '🤙', name: 'созвон звони на связи', cat: 'gestures' },
  { emoji: '👈', name: 'указатель влево смотри сюда', cat: 'gestures' },
  { emoji: '👉', name: 'указатель вправо туда ссылка', cat: 'gestures' },
  { emoji: '👆', name: 'указатель вверх читай выше сообщение', cat: 'gestures' },
  { emoji: '👇', name: 'указатель вниз читай ниже прикреплено', cat: 'gestures' },
  { emoji: '✍️', name: 'пишу ручка подпись договор заметка', cat: 'gestures' },
  { emoji: '🙏', name: 'пожалуйста спасибо благодарю мольба', cat: 'gestures' },

  // Офис и Работа
  { emoji: '💼', name: 'портфель бизнес работа кейс проект', cat: 'office' },
  { emoji: '📁', name: 'папка файлы документы архив', cat: 'office' },
  { emoji: '📂', name: 'открытая папка директория материалы', cat: 'office' },
  { emoji: '🗂', name: 'разделители папок картотека каталог', cat: 'office' },
  { emoji: '📅', name: 'календарь дата план график', cat: 'office' },
  { emoji: '📆', name: 'календарь день встреча совещание', cat: 'office' },
  { emoji: '📋', name: 'планшет задачи чек-лист список дел', cat: 'office' },
  { emoji: '📍', name: 'метка локация точка место офис', cat: 'office' },
  { emoji: '📏', name: 'линейка измерение размеры масштаб', cat: 'office' },
  { emoji: '🔓', name: 'открытый замок доступ открыт разрешено', cat: 'office' },
  { emoji: '🔑', name: 'ключ доступ права токен авторизация', cat: 'office' },
  { emoji: '🖥', name: 'монитор компьютер рабочий стол десктоп', cat: 'office' },
  { emoji: '🖨', name: 'принтер печать распечатать скан копия', cat: 'office' },
  { emoji: '⌨️', name: 'клавиатура набор текста код скрипт', cat: 'office' },
  { emoji: '🖱', name: 'мышь клик манипулятор управление', cat: 'office' },
  { emoji: '📱', name: 'телефон мобильный сотовый звонок', cat: 'office' },
  { emoji: '☎️', name: 'стационарный телефон добавочный номер АТС', cat: 'office' },
  { emoji: '📧', name: 'почта email письмо входящее', cat: 'office' },
  { emoji: '✉️', name: 'конверт письмо уведомление сообщение', cat: 'office' },
  { emoji: '📦', name: 'посылка коробка архив доставка релиз', cat: 'office' },

  // Знаки и Символы
  { emoji: '⚠️', name: 'предупреждение внимание осторожно баг риск', cat: 'symbols' },
  { emoji: '⛔', name: 'кирпич стоп въезд запрещен блокировка', cat: 'symbols' },
  { emoji: '🚫', name: 'запрет нельзя доступ запрещен', cat: 'symbols' },
  { emoji: '❓', name: 'вопрос неясность почему уточнить', cat: 'symbols' },
  { emoji: '❗', name: 'восклицательный знак важно срочно', cat: 'symbols' },
  { emoji: 'ℹ️', name: 'информация сведение справка инфо', cat: 'symbols' },
  { emoji: '🔔', name: 'колокольчик оповещение напоминание звук', cat: 'symbols' },
  { emoji: '🔕', name: 'без звука не беспокоить тихо', cat: 'symbols' },
  { emoji: '🚀', name: 'ракета запуск релиз старт вперед', cat: 'symbols' },
  { emoji: '⏰', name: 'будильник звонок дедлайн срок пора', cat: 'symbols' },
  { emoji: '🏆', name: 'кубок награда лучший сотрудник победа', cat: 'symbols' },
  { emoji: '⭐', name: 'звезда избранное оценка топ 5', cat: 'symbols' },
  { emoji: '🔥', name: 'огонь аврал срочно хит пожар', cat: 'symbols' },
  { emoji: '🛡️', name: 'щит безопасность страхование Сентрас защита', cat: 'symbols' },
  { emoji: '🌐', name: 'глобус интернет сеть портал веб-сайт', cat: 'symbols' }
];

const CATEGORIES = [
  { id: 'recent', label: 'Частые', icon: '⭐' },
  { id: 'smileys', label: 'Смайлы', icon: '😃' },
  { id: 'gestures', label: 'Жесты', icon: '👍' },
  { id: 'office', label: 'Офис', icon: '💼' },
  { id: 'symbols', label: 'Символы', icon: '⚡' }
];

export default function EmojiPicker({ onSelectEmoji, onClose }) {
  const [activeCategory, setActiveCategory] = useState('recent');
  const [searchQuery, setSearchQuery] = useState('');
  const pickerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const filteredEmojis = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return EMOJI_DATABASE.filter((item) => item.cat === activeCategory);
    }
    return EMOJI_DATABASE.filter((item) =>
      item.name.toLowerCase().includes(q) || item.emoji.includes(q)
    );
  }, [activeCategory, searchQuery]);

  return (
    <div className="emoji-picker-container" ref={pickerRef}>
      {/* Top Search Box */}
      <div className="emoji-picker-header">
        <div className="emoji-search-wrapper">
          <svg className="emoji-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            className="emoji-search-input"
            placeholder="Поиск эмодзи (ок, палец, отчет...)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          {searchQuery && (
            <button
              type="button"
              className="emoji-search-clear"
              onClick={() => setSearchQuery('')}
              title="Очистить"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Category Tabs */}
      {!searchQuery && (
        <div className="emoji-category-tabs">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={'emoji-cat-btn ' + (activeCategory === cat.id ? 'active' : '')}
              onClick={() => setActiveCategory(cat.id)}
              title={cat.label}
            >
              <span className="emoji-cat-icon">{cat.icon}</span>
              <span className="emoji-cat-text">{cat.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Emoji Grid */}
      <div className="emoji-grid-scroll">
        {filteredEmojis.length === 0 ? (
          <div className="emoji-empty-hint">
            Ничего не найдено по запросу "{searchQuery}"
          </div>
        ) : (
          <div className="emoji-grid">
            {filteredEmojis.map((item, idx) => (
              <button
                key={item.emoji + '-' + idx}
                type="button"
                className="emoji-cell-btn"
                title={item.name}
                onClick={() => {
                  onSelectEmoji(item.emoji);
                }}
              >
                {item.emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="emoji-picker-footer">
        <span className="emoji-footer-tip">Нажмите для быстрой вставки в текст сообщения</span>
      </div>
    </div>
  );
}
