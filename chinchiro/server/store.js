// データ保存。メモリ上に全データを持ち、変更があったキーだけを遅延保存する。
// DATABASE_URL があれば PostgreSQL、なければ DATA_DIR の JSON ファイルに保存。
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_DELAY_MS = 300;

function fileBackend(dir) {
  const fileOf = (key) => path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  return {
    name: `file (${dir})`,
    async loadAll() {
      await fs.mkdir(dir, { recursive: true });
      const out = new Map();
      for (const f of await fs.readdir(dir)) {
        if (!f.endsWith('.json')) continue;
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
        out.set(raw.key, raw.value);
      }
      return out;
    },
    async save(key, value) {
      const file = fileOf(key);
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ key, value }));
      await fs.rename(tmp, file);
    },
    async remove(key) {
      await fs.rm(fileOf(key), { force: true });
    },
  };
}

async function pgBackend(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  await pool.query('CREATE TABLE IF NOT EXISTS chinchiro_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  return {
    name: 'postgres',
    async loadAll() {
      const { rows } = await pool.query('SELECT key, value FROM chinchiro_kv');
      return new Map(rows.map((r) => [r.key, r.value]));
    },
    async save(key, value) {
      await pool.query(
        'INSERT INTO chinchiro_kv (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [key, JSON.stringify(value)],
      );
    },
    async remove(key) {
      await pool.query('DELETE FROM chinchiro_kv WHERE key = $1', [key]);
    },
  };
}

export async function createStore({ dataDir, databaseUrl }) {
  const backend = databaseUrl ? await pgBackend(databaseUrl) : fileBackend(dataDir);
  const loaded = await backend.loadAll();

  const db = {
    users: loaded.get('users') || {},
    sessions: loaded.get('sessions') || {},
    groups: {},
  };
  for (const [key, value] of loaded) {
    if (key.startsWith('group_')) db.groups[value.id] = value;
  }

  const dirty = new Set();
  const removed = new Set();
  let timer = null;
  let flushing = Promise.resolve();

  const valueOf = (key) => {
    if (key === 'users') return db.users;
    if (key === 'sessions') return db.sessions;
    return db.groups[key.slice('group_'.length)];
  };

  async function flush() {
    timer = null;
    const keys = [...dirty];
    const gone = [...removed];
    dirty.clear();
    removed.clear();
    for (const key of gone) await backend.remove(key);
    for (const key of keys) {
      const value = valueOf(key);
      if (value !== undefined) await backend.save(key, value);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      flushing = flushing.then(flush).catch((e) => console.error('[store] 保存に失敗しました', e));
    }, FLUSH_DELAY_MS);
  }

  return {
    db,
    backendName: backend.name,
    touchUsers() { dirty.add('users'); schedule(); },
    touchSessions() { dirty.add('sessions'); schedule(); },
    touchGroup(id) { dirty.add(`group_${id}`); schedule(); },
    deleteGroup(id) {
      delete db.groups[id];
      dirty.delete(`group_${id}`);
      removed.add(`group_${id}`);
      schedule();
    },
    async close() {
      if (timer) { clearTimeout(timer); flushing = flushing.then(flush); }
      await flushing;
    },
  };
}
