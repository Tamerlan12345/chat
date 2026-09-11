const { Pool } = require('pg');
const config = require('../../config');

// Целые числа PostgreSQL возвращает драйвером как есть (int4 → number), а вот
// bigint и numeric — строками, потому что они не умещаются в double. Все
// счётчики в схеме объявлены INTEGER именно поэтому: COUNT(*) возвращает
// bigint, и его приходится приводить отдельно — см. countRows ниже.

class PgDriver {
  constructor() {
    this.dialect = 'postgres';
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.PG_SSL,
      max: config.PG_POOL_MAX,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Имя видно в pg_stat_activity — когда база общая, сразу понятно, чьё
      // соединение висит.
      application_name: 'openmychat-identity',
      statement_timeout: config.PG_STATEMENT_TIMEOUT_MS
    });

    // Ошибка на простаивающем соединении приходит сюда, а не в await. Без
    // обработчика Node считает её необработанной и завершает процесс — то
    // есть единственный разрыв сети до базы ронял бы весь сервер.
    this.pool.on('error', (err) => {
      console.error('[Identity/pg] ошибка простаивающего соединения:', err.message);
    });
  }

  async connect() {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT version() AS v');
      const version = String(rows[0]?.v || '').split(' ').slice(0, 2).join(' ');
      const tls = config.PG_SSL
        ? config.PG_SSL.__insecure
          ? 'TLS без проверки сертификата'
          : 'TLS с проверкой сертификата'
        : 'без TLS (частная сеть)';
      console.log(`[Identity] PostgreSQL подключён: ${version}, ${tls}`);
      if (config.PG_SSL && config.PG_SSL.__insecure) {
        console.warn(
          '[Identity] ВНИМАНИЕ: проверка сертификата PostgreSQL отключена ' +
            '(DATABASE_SSL=no-verify или sslmode=require). Соединение шифруется, ' +
            'но подмена сервера не обнаруживается.'
        );
      }
    } finally {
      client.release();
    }
  }

  async query(text, params = []) {
    const res = await this.pool.query(text, params);
    return { rows: res.rows, rowCount: res.rowCount };
  }

  async get(text, params = []) {
    const { rows } = await this.query(text, params);
    return rows[0] || null;
  }

  async all(text, params = []) {
    const { rows } = await this.query(text, params);
    return rows;
  }

  async run(text, params = []) {
    const { rows, rowCount } = await this.query(text, params);
    return { changes: rowCount, rows };
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  /**
   * Транзакция на выделенном соединении. Всё, что делается внутри, должно идти
   * через переданный объект: обращение к this.query взяло бы другое соединение
   * из пула и осталось бы за пределами транзакции.
   */
  async tx(fn) {
    const client = await this.pool.connect();
    const scoped = {
      dialect: 'postgres',
      query: (t, p = []) => client.query(t, p).then((r) => ({ rows: r.rows, rowCount: r.rowCount })),
      get: (t, p = []) => client.query(t, p).then((r) => r.rows[0] || null),
      all: (t, p = []) => client.query(t, p).then((r) => r.rows),
      run: (t, p = []) => client.query(t, p).then((r) => ({ changes: r.rowCount, rows: r.rows })),
      exec: (t) => client.query(t).then(() => undefined)
    };
    try {
      await client.query('BEGIN');
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* соединение уже потеряно — откат произойдёт на стороне сервера */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = PgDriver;
