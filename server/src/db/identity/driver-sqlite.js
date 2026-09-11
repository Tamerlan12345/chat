const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config');

// Тот же интерфейс, что и у драйвера PostgreSQL, поверх отдельного файла
// SQLite. Нужен там, где PostgreSQL нет: локальная разработка и автотесты.
// Смысл не в том, чтобы дать вторую рабочую конфигурацию, а в том, чтобы
// проверяемый код и код в бою были одним кодом — весь слой выше работает
// через await и один и тот же диалект запросов.
//
// Запросы во всём проекте написаны с параметрами вида $1, $2 — их здесь
// переписывает toPositional. Нумерованная форма выбрана ради PostgreSQL:
// повторное использование одного значения в разных местах запроса там
// обязано ссылаться на один номер.

function toPositional(sql, params) {
  const values = [];
  const text = sql.replace(/\$(\d+)/g, (_, n) => {
    values.push(params[Number(n) - 1]);
    return '?';
  });
  return { text, values };
}

// node:sqlite отказывается связывать undefined и булевы значения. Первое —
// почти всегда незаполненное поле формы, второе — результат сравнения; оба
// должны доехать до базы как NULL и 0/1, а не уронить весь запрос.
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

class SqliteDriver {
  constructor(filePath = config.IDENTITY_DB_PATH) {
    this.dialect = 'sqlite';
    this.filePath = filePath;
  }

  async connect() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    console.log(`[Identity] Хранилище учётных записей: SQLite ${this.filePath}`);
    console.log(
      '[Identity] PostgreSQL не настроен (нет DATABASE_URL). Для рабочей ' +
        'установки задайте DATABASE_URL — учётные записи должны храниться в PostgreSQL.'
    );
  }

  _prepare(sql, params) {
    const { text, values } = toPositional(sql, params);
    return { stmt: this.db.prepare(text), values: values.map(bindable) };
  }

  async query(sql, params = []) {
    return { rows: await this.all(sql, params) };
  }

  async all(sql, params = []) {
    const { stmt, values } = this._prepare(sql, params);
    return stmt.all(...values);
  }

  async get(sql, params = []) {
    const { stmt, values } = this._prepare(sql, params);
    return stmt.get(...values) || null;
  }

  async run(sql, params = []) {
    const { stmt, values } = this._prepare(sql, params);
    // RETURNING нужен, чтобы вставка сразу отдавала присвоенный id — в
    // PostgreSQL другого способа нет, и ради единого кода он используется
    // и здесь.
    if (/\bRETURNING\b/i.test(sql)) {
      const row = stmt.get(...values);
      return { changes: 1, rows: row ? [row] : [] };
    }
    const info = stmt.run(...values);
    return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }

  async exec(sql) {
    this.db.exec(sql);
  }

  async tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* транзакция уже закрыта */
      }
      throw err;
    }
  }

  async close() {
    try {
      this.db?.close();
    } catch {
      /* уже закрыта */
    }
  }
}

module.exports = SqliteDriver;
module.exports.toPositional = toPositional;
