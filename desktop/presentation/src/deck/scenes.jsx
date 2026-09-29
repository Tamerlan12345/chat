import React from 'react';
import { Cover } from './cover.jsx';
import { Installer } from './installer.jsx';
import { Limits } from './limits.jsx';

const W = { role: 'saparova', title: 'CentyChat — Сапарова Айгерим Маратовна', subtitle: 'Рабочий ПК руководителя управления корпоративного страхования' };
const PEER = { role: 'akhmetov', title: 'CentyChat — Ахметов Данияр Серикович', subtitle: 'Рабочий ПК ведущего андеррайтера', width: 900, height: 700 };
const ME_SMALL = { ...W, width: 900, height: 700 };
const ADMIN = { role: 'admin', title: 'CentyChat — Администратор системы', subtitle: 'Рабочее место администратора' };

const dlg = (name) => ({ do: 'click', sel: '.dialog-list-item', text: name });

export const SLIDES = [
  {
    id: 'cover',
    tab: 'Титул',
    full: true,
    custom: Cover
  },

  {
    id: 'hero',
    tab: 'Обзор',
    kicker: 'Живая презентация',
    title: 'Это не скриншоты. Это само приложение',
    lead: 'В окнах ниже работает настоящий клиент CentyChat: тот же код, что ставится сотруднику. Сервер подставной и живет внутри файла, поэтому можно писать, открывать разделы и нажимать что угодно.',
    facts: [
      'Личные чаты и каналы, файлы и фото до 100 МБ',
      'Голосовые звонки, «Разбудить», оповещения с подтверждением',
      'Оргструктура компании, консоль администратора, журнал аудита'
    ],
    windows: [W],
    script: async (ctx) => {
      ctx.step('Открываем переписку с Данияром Ахметовым');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('saparova', dlg('Ахметов'));
      await ctx.wait(900);
      ctx.step('Коллега печатает ответ');
      ctx.srv().actions.typing(ctx.ids.akhmetov, ctx.ids.saparova, true);
      await ctx.wait(2200);
      ctx.srv().actions.typing(ctx.ids.akhmetov, ctx.ids.saparova, false);
      ctx.srv().actions.say(ctx.ids.akhmetov, ctx.ids.saparova, 'Айгерим Маратовна, полис по «Каспий Логистик» готов, отправил на согласование.');
      await ctx.wait(1500);
      ctx.step('Отвечаем прямо в окне');
      await ctx.cmd('saparova', { do: 'type', sel: 'textarea', text: 'Спасибо! Тариф оставляем прежний, подписываю сегодня.', enter: true, speed: 40 });
      await ctx.wait(1200);
      ctx.step('Коллега прочитал: одна галочка стала двумя');
      ctx.srv().actions.read(ctx.ids.akhmetov, ctx.ids.saparova);
      await ctx.wait(800);
      ctx.step('Дальше можно работать в окне самому');
    }
  },

  {
    id: 'install',
    tab: 'Установка',
    kicker: 'Установка',
    title: 'От файла в общей папке до окна в трее',
    lead: 'Установщик обычный: запустил, выбрал папку, нажал «Установить». Права администратора не нужны, приложение ставится в профиль сотрудника и дальше запускается вместе с Windows.',
    custom: Installer
  },

  {
    id: 'login',
    tab: 'Вход',
    kicker: 'Первый запуск',
    title: 'Вход в систему',
    lead: 'Адрес сервера задает ИТ, дальше сотрудник вводит логин и пароль. Это настоящий экран входа: он обращается к серверу и получает ответ.',
    facts: [
      'Адрес только по <b>https</b>, пароль по открытому каналу не уйдет',
      'После <b>10 неверных паролей</b> учетная запись блокируется на 15 минут',
      'Временный пароль система просит сменить при первом входе',
      'Сессия <b>12 часов</b>, продлевается сама, «Выход» закрывает ее на сервере'
    ],
    windows: [{ ...W, role: 'guest', title: 'CentyChat — вход', subtitle: 'Первый запуск на компьютере сотрудника' }],
    script: async (ctx) => {
      ctx.step('Сотрудник вводит логин');
      await ctx.cmd('guest', { do: 'type', sel: 'input[placeholder="Введите ваш логин"]', text: 'a.saparova', speed: 90 });
      await ctx.wait(400);
      ctx.step('Вводит пароль');
      await ctx.cmd('guest', { do: 'type', sel: 'input[type=password]', text: 'Рабочий-пароль-1', speed: 70 });
      await ctx.wait(500);
      ctx.step('Нажимает «Войти»');
      await ctx.cmd('guest', { do: 'click', sel: 'button[type=submit]' });
      await ctx.wait(1800);
      ctx.step('Сессия открыта, приложение загрузило контакты и переписку');
    }
  },

  {
    id: 'window',
    tab: 'Главное окно',
    kicker: 'Интерфейс',
    title: 'Разделы и строка состояния',
    lead: 'Слева разделы: чаты, каналы, контакты и важное. Внизу видно, кто в сети, и переключатель «Не беспокоить».',
    facts: [
      'Список диалогов с непрочитанными и временем последнего сообщения',
      'Зеленая полоса слева: собеседник сейчас в сети',
      '<b>Ctrl+K</b> — переход к человеку, каналу или сообщению',
      'Меню: профиль, смена сервера, консоль администратора, справка'
    ],
    windows: [W],
    script: async (ctx) => {
      ctx.step('Раздел «Чаты»: последние переписки');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.wait(1400);
      ctx.step('Раздел «Каналы»: общие и отдела');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Каналы' });
      await ctx.wait(1600);
      ctx.step('Раздел «Контакты»: оргструктура компании');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Контакты' });
      await ctx.wait(1600);
      ctx.step('Раздел «Важное»: приказы и оповещения');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Важное' });
      await ctx.wait(1600);
      ctx.step('Возвращаемся к чатам');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
    }
  },

  {
    id: 'chat',
    tab: 'Переписка',
    kicker: 'Два рабочих места',
    title: 'Сообщение, доставка, прочтение',
    lead: 'Слева Айгерим, справа Данияр. Оба окна подключены к одному серверу, поэтому видно обе стороны разговора сразу.',
    facts: [
      '<b>Enter</b> отправить, <b>Shift+Enter</b> новая строка',
      '✓ доставлено, ✓✓ прочитано — только в личных чатах',
      'Видно «... печатает...», уведомление приходит, если чат закрыт'
    ],
    windows: [ME_SMALL, PEER],
    script: async (ctx) => {
      ctx.step('Оба открывают переписку друг с другом');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('saparova', dlg('Ахметов'));
      await ctx.cmd('akhmetov', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('akhmetov', dlg('Сапарова'));
      await ctx.wait(900);
      ctx.step('Айгерим пишет сообщение');
      await ctx.cmd('saparova', { do: 'type', sel: 'textarea', text: 'Данияр, по «Каспий Логистик» нужен расчет к 16:00.', enter: true, speed: 38 });
      await ctx.wait(1200);
      ctx.step('Сообщение появилось у Данияра, отправителю пришла отметка о прочтении');
      await ctx.wait(900);
      ctx.step('Данияр отвечает из своего окна');
      await ctx.cmd('akhmetov', { do: 'type', sel: 'textarea', text: 'Принято, посчитаю на 38 единиц и пришлю файл.', enter: true, speed: 38 });
      await ctx.wait(1500);
      ctx.step('Попробуйте написать в любом из окон сами');
    }
  },

  {
    id: 'files',
    tab: 'Файлы',
    kicker: 'Файлы и фото',
    title: 'Лимит 100 МБ и просмотр фото',
    lead: 'Слишком большой файл отклоняется сразу, до начала загрузки. Фото грузится с прогрессом и открывается по клику.',
    facts: [
      'Предел 100 МБ проверяется в приложении и на сервере',
      'Не больше 2 загрузок одновременно, отправку можно отменить',
      'Скачать вложение могут только участники переписки'
    ],
    windows: [W],
    script: async (ctx) => {
      ctx.step('Открываем переписку и жмем «Вставить»');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('saparova', dlg('Ахметов'));
      await ctx.wait(700);
      await ctx.cmd('saparova', { do: 'click', sel: 'button', text: 'Вставить' });
      await ctx.wait(1200);
      ctx.step('Выбираем запись вебинара на 340 МБ');
      await ctx.cmd('saparova', { do: 'attach', kind: 'big' });
      await ctx.wait(1800);
      ctx.step('Приложение отказало сразу, файл даже не начал грузиться');
      await ctx.wait(1400);
      ctx.step('Теперь фото с осмотра: видно проценты загрузки');
      await ctx.cmd('saparova', { do: 'attach', kind: 'photo' });
      await ctx.wait(4200);
      ctx.step('Фото ушло миниатюрой, открываем его целиком');
      await ctx.cmd('saparova', { do: 'click', sel: '[aria-label^="Открыть изображение"]', last: true });
      await ctx.wait(2600);
      ctx.step('Закрываем просмотр');
      await ctx.cmd('saparova', { do: 'click', sel: '[aria-label="Закрыть (Esc)"], .image-viewer-close, button', text: 'Закрыть' }).catch(() => {});
    }
  },

  {
    id: 'channels',
    tab: 'Каналы',
    kicker: 'Каналы',
    title: 'Каналы отделов и компании',
    lead: 'Канал видит весь отдел. Сообщения приходят в реальном времени, непрочитанные считаются отдельно.',
    facts: [
      '<b>#Общий</b> и <b>#Объявления</b> есть у каждого сотрудника',
      'Канал, созданный в консоли, сразу включает всех',
      'В каналах отметок прочтения нет, только в личных чатах'
    ],
    windows: [W],
    script: async (ctx) => {
      ctx.step('Открываем канал «Корпоративное страхование»');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Каналы' });
      await ctx.wait(500);
      await ctx.cmd('saparova', { do: 'click', sel: '.dialog-list-item', text: 'Корпоративное страхование' });
      await ctx.wait(1300);
      ctx.step('Коллеги пишут в канал');
      ctx.srv().actions.typing(ctx.ids.akhmetov, 3, true, true);
      await ctx.wait(1800);
      ctx.srv().actions.typing(ctx.ids.akhmetov, 3, false, true);
      ctx.srv().actions.say(ctx.ids.akhmetov, 3, 'Расчет по «Каспий Логистик» готов, франшиза 0,5% при сроке два года.', { channel: true });
      await ctx.wait(1800);
      ctx.srv().actions.say(4, 3, 'Хорошо, тогда выносим на комитет в четверг.', { channel: true });
      await ctx.wait(1500);
      ctx.step('Пишем в канал сами');
      await ctx.cmd('saparova', { do: 'type', sel: 'textarea', text: 'Согласна. Данияр, подготовьте сравнение с прошлым договором.', enter: true, speed: 36 });
      await ctx.wait(1200);
    }
  },

  {
    id: 'contacts',
    tab: 'Контакты',
    kicker: 'Контакты',
    title: 'Оргструктура и статусы',
    lead: 'Дерево подразделений компании: видно, кто в сети, у кого «Не беспокоить», внутренние номера и непрочитанные.',
    facts: [
      'Поиск по ФИО, должности, отделу и внутреннему номеру',
      'Статусы ставятся сами: «Отошел» через 5 минут без мыши и клавиатуры',
      'Клик по сотруднику открывает переписку с ним'
    ],
    windows: [W],
    script: async (ctx) => {
      ctx.step('Открываем контакты');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Контакты' });
      await ctx.wait(1200);
      ctx.step('Раскрываем департамент андеррайтинга');
      await ctx.cmd('saparova', { do: 'click', sel: '.tree-dept-row', text: 'Андеррайти' });
      await ctx.wait(1600);
      ctx.step('Департамент корпоративных продаж: три человека в сети');
      await ctx.cmd('saparova', { do: 'click', sel: '.tree-dept-row', text: 'Корпоративных Продаж' });
      await ctx.wait(1700);
      ctx.step('Ищем по фамилии');
      await ctx.cmd('saparova', { do: 'type', sel: 'input[placeholder^="Поиск по ФИО"]', text: 'Нурланова', speed: 110 });
      await ctx.wait(1700);
      ctx.step('У Жанны Ерлановны включено «Не беспокоить»: красная точка');
      await ctx.wait(1400);
      ctx.step('Открываем переписку прямо из дерева');
      await ctx.cmd('saparova', { do: 'click', sel: '.tree-employee-node', text: 'Нурланова' });
      await ctx.wait(1400);
      ctx.step('И возвращаемся к дереву');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Контакты' });
      await ctx.cmd('saparova', { do: 'set', sel: 'input[placeholder^="Поиск по ФИО"]', text: '' });
    }
  },

  {
    id: 'wake',
    tab: 'Разбудить',
    kicker: 'Внимание коллеги',
    title: '«Разбудить», когда ответ нужен сейчас',
    lead: 'Кнопка в шапке чата подает сигнал и мигает окном у коллеги. Чтобы этим не злоупотребляли, нажать ее можно раз в минуту.',
    facts: [
      'Сигнал звучит до 30 секунд, окно выходит вперед',
      'Ответ одной кнопкой: «Я на месте» или «Открыть переписку»',
      'Коллегу в режиме «Не беспокоить» разбудить нельзя'
    ],
    windows: [ME_SMALL, PEER],
    script: async (ctx) => {
      ctx.step('Открываем чат с Данияром');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('saparova', dlg('Ахметов'));
      await ctx.wait(900);
      ctx.step('Нажимаем «Разбудить»');
      await ctx.cmd('saparova', { do: 'wake' });
      await ctx.wait(2000);
      ctx.step('У Данияра окно сигнала и отсчет у отправителя');
      await ctx.wait(2200);
      ctx.step('Данияр открывает переписку прямо из окна сигнала');
      await ctx.cmd('akhmetov', { do: 'click', sel: 'button', text: 'Открыть переписку' });
      await ctx.wait(1200);
      ctx.step('Кнопка ждет минуту: чаще будить нельзя');
    }
  },

  {
    id: 'call',
    tab: 'Звонок',
    kicker: 'Голосовая связь',
    title: 'Звонок внутри компании',
    lead: 'Звонок один на один, только голос. Сигнал идет через сервер компании, наружу ничего не выходит.',
    facts: [
      'Без ответа <b>45 секунд</b> вызов завершается',
      'Во время разговора таймер и выключение микрофона',
      'Звонить может роль, которой разрешены голосовые звонки'
    ],
    windows: [ME_SMALL, PEER],
    script: async (ctx) => {
      ctx.step('Открываем чат и звоним');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('saparova', dlg('Ахметов'));
      await ctx.wait(700);
      await ctx.cmd('saparova', { do: 'call' });
      await ctx.wait(1800);
      ctx.step('У Данияра входящий вызов');
      await ctx.wait(1500);
      ctx.step('Данияр принимает звонок');
      await ctx.cmd('akhmetov', { do: 'click', sel: 'button', text: 'Принять' });
      await ctx.wait(3000);
      ctx.step('Идет разговор, виден таймер');
      await ctx.wait(2500);
      ctx.step('Завершаем');
      await ctx.cmd('saparova', { do: 'click', sel: 'button', text: 'Завершить' });
    }
  },

  {
    id: 'important',
    tab: 'Важное',
    kicker: 'Приказы и оповещения',
    title: 'Ознакомление под подпись',
    lead: 'Слева сотрудник, справа администратор. Сотрудник подтверждает ознакомление, и у администратора в реестре сразу видно, кто и когда это сделал.',
    facts: [
      'Срочный приказ требует подтверждения, обычное оповещение просто читают',
      'Время подтверждения фиксируется на сервере',
      'Публиковать может администратор или роль с правом рассылки'
    ],
    windows: [ME_SMALL, { ...ADMIN, width: 900, height: 700 }],
    script: async (ctx) => {
      ctx.step('Сотрудник открывает «Важное» и читает приказ');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Важное' });
      await ctx.wait(900);
      await ctx.cmd('saparova', { do: 'click', sel: '.announcement-card-item', text: 'Новый порядок' });
      await ctx.wait(1500);
      ctx.step('Администратор открывает тот же приказ: подтвердили шестеро');
      await ctx.cmd('admin', { do: 'rail', tab: 'Важное' });
      await ctx.wait(800);
      await ctx.cmd('admin', { do: 'click', sel: '.announcement-card-item', text: 'Новый порядок' });
      await ctx.wait(1400);
      await ctx.cmd('admin', { do: 'scrollTo', sel: 'h4', text: 'Реестр ознакомления' }).catch(() => {});
      await ctx.wait(1600);
      ctx.step('Сотрудник нажимает «Я ознакомлен(а)»');
      await ctx.cmd('saparova', { do: 'click', sel: 'button', text: 'Я ознакомлен' });
      await ctx.wait(1800);
      ctx.step('Администратор открывает реестр заново: отметка уже там');
      await ctx.cmd('admin', { do: 'click', sel: '.announcement-card-item', text: 'Плановые работы' });
      await ctx.wait(800);
      await ctx.cmd('admin', { do: 'click', sel: '.announcement-card-item', text: 'Новый порядок' });
      await ctx.wait(1500);
      await ctx.cmd('admin', { do: 'scrollTo', sel: 'h4', text: 'Реестр ознакомления' }).catch(() => {});
      await ctx.wait(1400);
    }
  },

  {
    id: 'search',
    tab: 'Поиск',
    kicker: 'Быстрый переход',
    title: 'Ctrl+K: человек, канал, сообщение',
    lead: 'Одно окно поиска на все: коллеги, каналы и текст переписки. Стрелки выбирают, Enter открывает.',
    facts: [
      'Поиск по сообщениям начинается с двух символов',
      'Показываются только свои чаты и каналы',
      'Уведомление в углу открывает нужный чат по клику'
    ],
    windows: [W],
    script: async (ctx) => {
      ctx.step('Нажимаем Ctrl+K');
      await ctx.cmd('saparova', { do: 'key', key: 'k', ctrl: true });
      await ctx.wait(900);
      ctx.step('Ищем по слову «франшиз»');
      await ctx.cmd('saparova', { do: 'type', sel: '.command-palette input, input[placeholder*="Найти"]', text: 'франшиз', speed: 130 });
      await ctx.wait(2200);
      ctx.step('Пока смотрим поиск, коллега пишет в другой чат');
      ctx.srv().actions.say(4, ctx.ids.saparova, 'Айгерим, отчет по продажам за неделю готов.');
      await ctx.wait(2200);
      ctx.step('Уведомление в углу: клик открывает переписку');
    }
  },

  {
    id: 'theme',
    tab: 'Тема',
    kicker: 'Оформление',
    title: 'Тема по времени суток',
    lead: 'С 6:00 до 15:00 светлая, с 15:00 до 6:00 темная. Переключение происходит само, без перезапуска.',
    facts: ['Тема меняется по часам компьютера', 'Ночью интерфейс не слепит, днем читается при ярком свете'],
    theme: 'dark',
    windows: [{ ...W, subtitle: 'Вечерний режим: с 15:00 до 6:00' }],
    script: async (ctx) => {
      ctx.step('Открываем переписку в темной теме');
      await ctx.cmd('saparova', { do: 'rail', tab: 'Чаты' });
      await ctx.cmd('saparova', dlg('Ахметов'));
      await ctx.wait(1500);
      ctx.step('Наступило утро: тема стала светлой');
      await ctx.cmd('saparova', { do: 'theme', theme: 'light' });
      await ctx.wait(2600);
      ctx.step('Вечер: снова темная');
      await ctx.cmd('saparova', { do: 'theme', theme: 'dark' });
      await ctx.wait(1600);
    }
  },

  {
    id: 'admin',
    tab: 'Консоль',
    kicker: 'Администратор',
    title: 'Сотрудники, права, подразделения',
    lead: 'Консоль открывается из меню «Инструменты». Это настоящая консоль приложения с данными сервера.',
    facts: [
      'Добавление сотрудника, блокировка, сброс пароля одноразовым',
      'Импорт оргструктуры текстом или CSV, привязка ПК к сотруднику',
      '«Контурный администратор» управляет только своим подразделением'
    ],
    windows: [ADMIN],
    script: async (ctx) => {
      ctx.step('Открываем консоль управления сервером');
      await ctx.cmd('admin', { do: 'menu', top: 'Инструменты', item: 'Консоль управления сервером' });
      await ctx.wait(2000);
      ctx.step('Список сотрудников');
      await ctx.cmd('admin', { do: 'click', sel: '.admin-nav-item', text: 'Пользователи' });
      await ctx.wait(2200);
      ctx.step('Права ролей: девять разрешений');
      await ctx.cmd('admin', { do: 'click', sel: '.admin-nav-item', text: 'Управление правами' });
      await ctx.wait(2600);
      ctx.step('Подразделения и импорт оргструктуры');
      await ctx.cmd('admin', { do: 'click', sel: '.admin-nav-item', text: 'Пользователи' });
      await ctx.wait(600);
      await ctx.cmd('admin', { do: 'click', sel: 'button', text: 'Подразделения' }).catch(() => {});
      await ctx.wait(2000);
    }
  },

  {
    id: 'security',
    tab: 'Безопасность',
    kicker: 'Администратор и ИБ',
    title: 'Состояние защиты, журнал, оповещения',
    lead: 'Сервер сам проверяет свои настройки, ведет журнал с контролем целостности и сразу сообщает о подозрительном.',
    facts: [
      'Журнал: входы, неудачные попытки, изменения прав, действия в консоли',
      'Чтение переписки администратором тоже попадает в журнал',
      'Резервные копии каждые 24 часа, шифруются ключом развертывания'
    ],
    windows: [ADMIN],
    script: async (ctx) => {
      ctx.step('Открываем раздел «Безопасность»');
      await ctx.cmd('admin', { do: 'menu', top: 'Инструменты', item: 'Консоль управления сервером' });
      await ctx.wait(1600);
      await ctx.cmd('admin', { do: 'click', sel: '.admin-nav-item', text: 'Безопасность' });
      await ctx.wait(2400);
      ctx.step('Журнал аудита и проверка целостности');
      await ctx.cmd('admin', { do: 'click', sel: '[role="tab"]', text: 'Журнал аудита' });
      await ctx.wait(1500);
      await ctx.cmd('admin', { do: 'click', sel: 'button', text: 'Проверить целостность' });
      await ctx.wait(2000);
      ctx.step('Подбор пароля: оповещение приходит сразу');
      ctx.srv().actions.securityAlert({
        id: 9001,
        rule: 'login_bruteforce',
        severity: 'high',
        title: 'Подбор пароля',
        details: { ip: '10.20.4.17', attempts: 11 },
        created_at: new Date().toISOString(),
        acknowledged_at: null
      });
      await ctx.wait(2600);
      ctx.step('Оповещения видны и в разделе «Оповещения»');
      await ctx.cmd('admin', { do: 'click', sel: '[role="tab"]', text: 'Оповещения' });
      await ctx.wait(1800);
    }
  },

  {
    id: 'limits',
    tab: 'Итоги',
    kicker: 'Честно о текущей версии',
    title: 'Что готово и что решаем до запуска',
    custom: Limits
  }
];
