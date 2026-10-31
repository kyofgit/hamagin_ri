import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { Server } from 'socket.io';
import { createStore } from './store.js';
import { GameError, startRound, sync, roll, skip, turnKey } from './game.js';

const scrypt = promisify(scryptCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 180;
const COOKIE = 'cc_sid';
export const COLORS = ['#E5483A', '#2F6FDB', '#1F9D6B', '#D98A1F', '#8B5CF6', '#0E9FB0', '#D9468A', '#5B6B7C', '#9A6A3C', '#5E9E2F'];

const store = await createStore({
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  databaseUrl: process.env.DATABASE_URL,
});
const { db } = store;

// 期限切れセッションの掃除
for (const [token, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[token];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);

// ---------- 共通ヘルパー ----------
const fail = (status, message) => Object.assign(new Error(message), { status });
const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function userFromCookie(header) {
  const token = parseCookies(header)[COOKIE];
  const s = token && db.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.uid] || null;
}

async function hashPassword(password, salt = newId(16)) {
  const hash = (await scrypt(password, salt, 32)).toString('base64');
  return { salt, hash };
}

async function verifyPassword(user, password) {
  const { hash } = await hashPassword(password, user.salt);
  const a = Buffer.from(hash);
  const b = Buffer.from(user.hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

function startSession(req, res, user) {
  const token = randomBytes(32).toString('base64url');
  db.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_DAYS * 86400_000 };
  store.touchSessions();
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

const auth = (req, _res, next) => {
  req.user = userFromCookie(req.headers.cookie);
  if (!req.user) throw fail(401, 'ログインしてください');
  next();
};

function groupFor(req) {
  const group = db.groups[req.params.id];
  if (!group || !group.members[req.user.id]) throw fail(404, 'グループが見つかりません');
  return group;
}

const ownerOnly = (group, user) => {
  if (group.ownerId !== user.id) throw fail(403, 'グループの作成者だけが変更できます');
};

const publicUser = (u) => ({ uid: u.id, name: u.name, color: u.color });

// ---------- オンライン状態 ----------
const presence = new Map(); // groupId -> Map(uid -> 接続数)
const onlineOf = (gid) => [...(presence.get(gid)?.keys() || [])];

function groupView(group) {
  const online = new Set(onlineOf(group.id));
  return {
    id: group.id,
    name: group.name,
    code: group.code,
    ownerId: group.ownerId,
    settings: group.settings,
    order: group.order,
    members: group.order.map((uid) => ({
      ...publicUser(db.users[uid]),
      away: !!group.members[uid].away,
      joinedAt: group.members[uid].joinedAt,
      online: online.has(uid),
    })),
    game: { ...group.game, key: turnKey(group) },
    lastRound: group.lastRound || null,
  };
}

function peopleOf(group) {
  const ids = new Set(group.order);
  for (const r of group.records) ids.add(r.u);
  const out = {};
  for (const uid of ids) if (db.users[uid]) out[uid] = publicUser(db.users[uid]);
  return out;
}

function broadcast(group, event = { kind: 'sync' }) {
  group.updatedAt = Date.now();
  store.touchGroup(group.id);
  io.to(`g:${group.id}`).emit('update', { group: groupView(group), event });
}

// ---------- 認証 ----------
const loginAttempts = new Map();
function throttle(req) {
  const key = req.ip;
  const a = loginAttempts.get(key);
  if (a && a.until > Date.now() && a.count >= 8) throw fail(429, '試行回数が多すぎます。少し待ってからお試しください');
}
function noteFailure(req) {
  const a = loginAttempts.get(req.ip);
  if (!a || a.until < Date.now()) loginAttempts.set(req.ip, { count: 1, until: Date.now() + 60_000 });
  else a.count++;
}

const findByLoginId = (loginId) => Object.values(db.users).find((u) => u.loginId === loginId.toLowerCase());

app.post('/api/auth/register', async (req, res) => {
  const loginId = str(req.body.loginId);
  const name = str(req.body.name);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(loginId)) throw fail(400, 'ログインIDは半角英数字（3〜20文字）で入力してください');
  if (password.length < 4 || password.length > 72) throw fail(400, 'パスワードは4文字以上にしてください');
  if (!name || name.length > 12) throw fail(400, '表示名は1〜12文字で入力してください');
  if (findByLoginId(loginId)) throw fail(409, 'このログインIDはすでに使われています');
  const user = {
    id: newId(),
    loginId: loginId.toLowerCase(),
    name,
    color: COLORS[Object.keys(db.users).length % COLORS.length],
    ...(await hashPassword(password)),
    createdAt: Date.now(),
    groups: [],
  };
  db.users[user.id] = user;
  store.touchUsers();
  startSession(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  throttle(req);
  const user = findByLoginId(str(req.body.loginId));
  if (!user || !(await verifyPassword(user, String(req.body.password || '')))) {
    noteFailure(req);
    throw fail(401, 'ログインIDかパスワードが違います');
  }
  startSession(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token && db.sessions[token]) { delete db.sessions[token]; store.touchSessions(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const groups = req.user.groups.map((gid) => db.groups[gid]).filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((g) => ({
      id: g.id,
      name: g.name,
      round: g.game.round,
      records: g.records.filter((r) => r.h !== 'skip').length,
      updatedAt: g.updatedAt,
      members: g.order.map((uid) => publicUser(db.users[uid])),
    }));
  res.json({ user: { ...publicUser(req.user), loginId: req.user.loginId }, groups, colors: COLORS });
});

app.patch('/api/me', auth, async (req, res) => {
  const u = req.user;
  if (req.body.name !== undefined) {
    const name = str(req.body.name);
    if (!name || name.length > 12) throw fail(400, '表示名は1〜12文字で入力してください');
    u.name = name;
  }
  if (req.body.color !== undefined) {
    if (!COLORS.includes(req.body.color)) throw fail(400, '色が正しくありません');
    u.color = req.body.color;
  }
  if (req.body.password !== undefined) {
    if (!(await verifyPassword(u, String(req.body.currentPassword || '')))) throw fail(400, '現在のパスワードが違います');
    const pw = String(req.body.password);
    if (pw.length < 4 || pw.length > 72) throw fail(400, 'パスワードは4文字以上にしてください');
    Object.assign(u, await hashPassword(pw));
  }
  store.touchUsers();
  for (const gid of u.groups) if (db.groups[gid]) broadcast(db.groups[gid]);
  res.json({ user: publicUser(u) });
});

// ---------- グループ ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const code = Array.from(randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!Object.values(db.groups).some((g) => g.code === code)) return code;
  }
}

function addMember(group, user) {
  if (group.members[user.id]) return;
  group.members[user.id] = { joinedAt: Date.now(), away: false };
  group.order.push(user.id);
  if (!user.groups.includes(group.id)) user.groups.push(group.id);
  store.touchUsers();
}

app.post('/api/groups', auth, (req, res) => {
  const name = str(req.body.name);
  if (!name || name.length > 20) throw fail(400, 'グループ名は1〜20文字で入力してください');
  const group = {
    id: newId(),
    name,
    code: newCode(),
    ownerId: req.user.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    members: {},
    order: [],
    settings: { shonben: false, shonbenRate: 0.05 },
    records: [],
    seq: 0,
    lastRound: null,
  };
  addMember(group, req.user);
  startRound(group, 1);
  db.groups[group.id] = group;
  store.touchGroup(group.id);
  res.json({ id: group.id });
});

app.post('/api/groups/join', auth, (req, res) => {
  const code = str(req.body.code).toUpperCase();
  const group = Object.values(db.groups).find((g) => g.code === code);
  if (!group) throw fail(404, '招待コードが見つかりません');
  if (!group.members[req.user.id]) {
    addMember(group, req.user);
    const done = sync(group);
    broadcast(group, { kind: 'sync', ...done, records: done.updated });
  }
  res.json({ id: group.id });
});

app.get('/api/groups/:id', auth, (req, res) => {
  const group = groupFor(req);
  res.json({ group: groupView(group), records: group.records, people: peopleOf(group) });
});

app.patch('/api/groups/:id', auth, (req, res) => {
  const group = groupFor(req);
  ownerOnly(group, req.user);
  if (req.body.name !== undefined) {
    const name = str(req.body.name);
    if (!name || name.length > 20) throw fail(400, 'グループ名は1〜20文字で入力してください');
    group.name = name;
  }
  const s = req.body.settings;
  if (s) {
    if (s.shonben !== undefined) group.settings.shonben = !!s.shonben;
    if (s.shonbenRate !== undefined) {
      const rate = Number(s.shonbenRate);
      if (!(rate >= 0.01 && rate <= 0.3)) throw fail(400, 'ションベン確率は1〜30%で指定してください');
      group.settings.shonbenRate = rate;
    }
  }
  broadcast(group);
  res.json({ ok: true });
});

async function removeMember(group, uid) {
  delete group.members[uid];
  group.order = group.order.filter((x) => x !== uid);
  const user = db.users[uid];
  if (user) { user.groups = user.groups.filter((g) => g !== group.id); store.touchUsers(); }
  for (const s of io.of('/').sockets.values()) {
    if (s.data.uid === uid && s.data.gid === group.id) {
      s.leave(`g:${group.id}`);
      s.data.gid = null;
      setPresence(group.id, uid, -1);
      s.emit('removed', { groupId: group.id });
    }
  }
  if (group.order.length === 0) { store.deleteGroup(group.id); return; }
  if (group.ownerId === uid) {
    group.ownerId = [...group.order].sort((a, b) => group.members[a].joinedAt - group.members[b].joinedAt)[0];
  }
  const done = sync(group);
  broadcast(group, { kind: 'sync', ...done, records: done.updated });
}

app.post('/api/groups/:id/leave', auth, async (req, res) => {
  await removeMember(groupFor(req), req.user.id);
  res.json({ ok: true });
});

app.post('/api/groups/:id/kick', auth, async (req, res) => {
  const group = groupFor(req);
  ownerOnly(group, req.user);
  const uid = str(req.body.uid);
  if (!group.members[uid] || uid === req.user.id) throw fail(400, 'このメンバーは外せません');
  await removeMember(group, uid);
  res.json({ ok: true });
});

app.delete('/api/groups/:id', auth, async (req, res) => {
  const group = groupFor(req);
  ownerOnly(group, req.user);
  io.to(`g:${group.id}`).emit('removed', { groupId: group.id, deleted: true });
  for (const uid of group.order) {
    const u = db.users[uid];
    if (u) u.groups = u.groups.filter((g) => g !== group.id);
  }
  store.touchUsers();
  store.deleteGroup(group.id);
  res.json({ ok: true });
});

// ---------- ゲーム操作 ----------
app.post('/api/groups/:id/roll', auth, (req, res) => {
  const group = groupFor(req);
  const result = roll(group, req.user.id, req.body.key);
  const records = result.record ? [result.record, ...result.updated.filter((r) => r !== result.record)] : [];
  broadcast(group, {
    kind: 'roll', actor: req.user.id, uid: result.uid, dice: result.dice, rollNo: result.rollNo,
    shonben: result.shonben, hand: result.hand, final: !!result.record, roundEnd: result.roundEnd, records,
  });
  res.json({ ok: true });
});

app.post('/api/groups/:id/skip', auth, (req, res) => {
  const group = groupFor(req);
  const result = skip(group, req.user.id, req.body.key);
  broadcast(group, { kind: 'skip', actor: req.user.id, uid: result.uid, roundEnd: result.roundEnd, records: [result.record, ...result.updated] });
  res.json({ ok: true });
});

app.post('/api/groups/:id/away', auth, (req, res) => {
  const group = groupFor(req);
  const uid = str(req.body.uid) || req.user.id;
  if (!group.members[uid]) throw fail(404, 'メンバーが見つかりません');
  group.members[uid].away = !!req.body.away;
  const done = sync(group);
  broadcast(group, { kind: 'sync', ...done, records: done.updated });
  res.json({ ok: true });
});

app.post('/api/groups/:id/order', auth, (req, res) => {
  const group = groupFor(req);
  let order = req.body.order;
  if (req.body.shuffle) {
    order = [...group.order];
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomBytes(1)[0] % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  if (!Array.isArray(order) || order.length !== group.order.length || !group.order.every((u) => order.includes(u))) {
    throw fail(400, '順番が正しくありません');
  }
  group.order = order;
  const done = sync(group);
  broadcast(group, { kind: 'sync', ...done, records: done.updated });
  res.json({ ok: true });
});

app.use('/api', (_req, _res, next) => next(fail(404, '見つかりません')));
app.use((err, _req, res, _next) => {
  const status = err instanceof GameError ? err.status : err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'サーバーでエラーが起きました' : err.message });
});

// ---------- リアルタイム通信 ----------
io.use((socket, next) => {
  const user = userFromCookie(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  socket.data.uid = user.id;
  next();
});

function setPresence(gid, uid, delta) {
  if (!presence.has(gid)) presence.set(gid, new Map());
  const m = presence.get(gid);
  const n = (m.get(uid) || 0) + delta;
  if (n > 0) m.set(uid, n); else m.delete(uid);
  io.to(`g:${gid}`).emit('presence', { online: onlineOf(gid) });
}

io.on('connection', (socket) => {
  const leave = () => {
    const gid = socket.data.gid;
    if (!gid) return;
    socket.leave(`g:${gid}`);
    socket.data.gid = null;
    setPresence(gid, socket.data.uid, -1);
  };
  socket.on('watch', (gid, ack) => {
    leave();
    const group = db.groups[gid];
    if (!group || !group.members[socket.data.uid]) return ack?.({ ok: false });
    socket.join(`g:${gid}`);
    socket.data.gid = gid;
    setPresence(gid, socket.data.uid, 1);
    ack?.({ ok: true });
  });
  socket.on('unwatch', leave);
  socket.on('disconnect', leave);
});

server.listen(PORT, () => {
  console.log(`チンチロ起動: http://localhost:${PORT}  (保存先: ${store.backendName})`);
});

async function shutdown() {
  server.close();
  io.close();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
