import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged,
  signOut, connectAuthEmulator, signInWithCredential,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, onSnapshot, getDoc, getDocs, setDoc, runTransaction, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { firebaseConfig, emulatorConfig } from './config.js';
import { MAX_ROLLS, HANDS, handLabel } from './rules.js';
import { roll, skip, sync, startRound, turnKey, dec, enc, GameError } from './game.js';
import { roundsOf } from './analysis.js';
import { renderStats } from './stats.js';
import { esc, COLORS, fgFor, fmtTime, fmtDate, pips, miniDice, tierOf, handChip, dot } from './ui.js';

/* ---------- 定数 ---------- */
const params = new URLSearchParams(location.search);
const EMU = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('emu');
const ROOMS = 'chinchiroRooms';
const USERS = 'chinchiroUsers';
const MAX_MEMBERS = 12;
const CHUNK = 100; // 記録は100件ずつ1つのドキュメントにまとめる
const KEEP_CHUNKS = 10; // 最新1000〜1100件を保持
const ID_RE = /^[a-z0-9]{6,24}$/;
const ROLL_MIN_MS = 900;

/* ---------- アプリ内ブラウザ対策（LINEは外部ブラウザで開き直す） ---------- */
const UA = navigator.userAgent;
if (/\bLine\//i.test(UA) && !params.has('openExternalBrowser')) {
  params.set('openExternalBrowser', '1');
  location.replace(`${location.pathname}?${params}`);
}
const IN_APP = /\bLine\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(UA);

/* ---------- 小物 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const rid = (n = 10) => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += a[x % a.length];
  return s;
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境でも動かす */ } },
};
const readJSON = (k) => { try { return JSON.parse(ls.get(k)) || {}; } catch { return {}; } };
const firstName = (s) => (s || '').trim().split(/\s+/)[0] || '';
const defaultRoomName = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()} の会`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

/* ---------- Firebase ---------- */
const cfg = EMU ? emulatorConfig : firebaseConfig;
const app = initializeApp(cfg);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
if (EMU) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  window.__cc = {
    login: (sub, name) => signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({
      sub, email: `${sub}@example.com`, name, email_verified: true,
    }))),
    state: () => S,
    // テスト用：演出なしで、いまの手番を自分の操作として1投振る
    rollNow: () => mutate((room) => {
      if (room.game.turn?.uid !== uid()) return {};
      const res = roll(room, uid(), turnKey(room));
      room.ev = { ...evBase('roll'), uid: res.uid, dice: enc(res.dice), rollNo: res.rollNo, hand: res.hand, final: res.final, sb: res.sb, round: res.roundEnd?.round ?? null };
      return res;
    }),
  };
}

/* ---------- 状態 ---------- */
const prefs = { vibrate: true, sound: true, toast: true, wake: true, ...readJSON('cc.prefs') };
const savePrefs = () => ls.set('cc.prefs', JSON.stringify(prefs));
const S = {
  user: null, nick: '', userData: {}, unsubUser: null,
  roomId: null, roomRef: null, room: null, unsubRoom: null, unsubChunks: null, primed: false, joining: false,
  lastEv: null, recentName: null, queue: [], busy: false, rolling: null, dicePos: null, shown: null,
  chunks: new Map(), records: [],
  sheet: null, tab: 'members', palette: null,
  stats: { period: 'today', custom: {}, view: 'overview', member: null, metric: 'hand:shigoro' },
  logMember: null, logLimit: 15,
};
const uid = () => S.user?.uid;
const userRef = () => doc(db, USERS, uid());
const chunkRef = (roomRef, k) => doc(roomRef, 'chunks', String(k).padStart(4, '0'));
const chunkOf = (id) => Math.floor((id - 1) / CHUNK);

const person = (u) => S.room?.members?.[u] || S.room?.people?.[u] || { name: '退会したメンバー', color: '#3A3A42' };
const nameOf = (u) => person(u).name;
const colorOf = (u) => person(u).color;
const isOwner = () => S.room?.createdBy === uid();

/* ---------- 画面切替 ---------- */
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}
function showMsg(title, text, actions = []) {
  $('#msgTitle').textContent = title;
  $('#msgText').textContent = text;
  $('#msgActions').replaceChildren(...actions.map(([label, fn, cls]) => {
    const b = document.createElement('button');
    b.className = `btn ${cls || ''}`;
    b.textContent = label;
    b.onclick = fn;
    return b;
  }));
  show('msg');
}

/* ---------- トースト ---------- */
function toast(html, opts = {}) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="t-main">${html}</span>`;
  if (opts.key) { box.querySelector(`[data-key="${opts.key}"]`)?.remove(); t.dataset.key = opts.key; }
  box.prepend(t);
  while (box.children.length > 3) box.lastChild.remove();
  if (box.showPopover) { try { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); } catch { /* 非対応 */ } }
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, opts.ms || 2200);
}
function fail(err) {
  if (err instanceof GameError) { toast(esc(err.message), { key: 'err' }); return; }
  console.error(err);
  const code = err?.code || '';
  const msg = code === 'permission-denied' ? '権限がありません。ログインし直してください'
    : code === 'unavailable' ? 'オフラインです。つながると同期されます'
      : code === 'not-found' ? 'データが見つかりません'
        : '問題が発生しました。もう一度お試しください';
  toast(esc(msg), { ms: 3500, key: 'err' });
}

/* ---------- 振動・音 ---------- */
const CAN_VIBRATE = typeof navigator.vibrate === 'function';
const vib = (p) => { if (prefs.vibrate && CAN_VIBRATE) { try { navigator.vibrate(p); } catch { /* 無視 */ } } };
let actx = null;
function audio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!actx) actx = new AC();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
document.addEventListener('pointerdown', () => { if (prefs.sound) audio(); }, { passive: true });
function tone(f1, f2, dur = 0.16, vol = 0.22) {
  if (!prefs.sound || !actx || actx.state !== 'running') return;
  const t = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(f2, t + dur * 0.7);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function handTone(hand) {
  const tier = tierOf(hand);
  if (tier === 'gold') tone(523, 1046, 0.4, 0.25);
  else if (tier === 'red') tone(520, 330, 0.3);
  else if (tier === 'mute') tone(440, 400, 0.12, 0.15);
  else tone(620, 980);
}

/* ---------- 画面スリープ防止 ---------- */
let wakeLock = null;
async function wake() {
  if (!prefs.wake || !('wakeLock' in navigator) || document.hidden || !S.roomId || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 非対応・拒否 */ }
}
function unwake() { wakeLock?.release().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

/* ---------- 端末の「戻る」で最前面の1枚だけ閉じる ---------- */
const layers = [];
function pushLayer(close) {
  const token = { close };
  layers.push(token);
  history.pushState({ ccLayer: layers.length }, '');
  return token;
}
function popLayerByUi(token) {
  const i = layers.indexOf(token);
  if (i < 0) return;
  layers.splice(i, 1);
  S.ignorePop = true;
  history.back();
}
window.addEventListener('popstate', () => {
  if (S.ignorePop) { S.ignorePop = false; return; }
  const top = layers.pop();
  if (top) { S.closingByPop = true; top.close(); S.closingByPop = false; }
});

/* ---------- 認証 ---------- */
async function login() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
      await signInWithRedirect(auth, provider);
    } else if (!['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code)) {
      fail(e);
    }
  }
}

function start() {
  for (const el of document.querySelectorAll('.mosaic b, .logo-mark i')) el.innerHTML = pips(Number(el.dataset.v));
  $('#btnLogin').onclick = login;
  $('#inAppNote').hidden = !IN_APP;
  onAuthStateChanged(auth, (u) => {
    S.user = u;
    if (!u) { S.unsubUser?.(); S.unsubUser = null; leave(); show('login'); return; }
    S.nick = ls.get(`cc.nick:${u.uid}`) || firstName(u.displayName) || 'ゲスト';
    S.unsubUser?.();
    S.unsubUser = onSnapshot(userRef(), (s) => {
      S.userData = s.data() || {};
      if (S.userData.nick && !ls.get(`cc.nick:${u.uid}`)) S.nick = S.userData.nick;
      if (S.sheet === 'settings' && S.tab === 'room') renderSheet();
    }, () => {});
    boot();
  });
}

async function boot() {
  const fromUrl = params.get('r');
  if (fromUrl && ID_RE.test(fromUrl)) return openRoom(fromUrl);
  const last = ls.get(`cc.lastRoom:${uid()}`);
  if (last && ID_RE.test(last)) return openRoom(last);
  try {
    const s = await getDoc(userRef());
    const l = s.data()?.lastRoom;
    if (l && ID_RE.test(l)) return openRoom(l);
  } catch { /* 初回 */ }
  createRoom(defaultRoomName());
}

/* ---------- ルーム ---------- */
function roomUrl(id, share = false) {
  const p = new URLSearchParams();
  p.set('r', id);
  if (EMU) p.set('emu', '1');
  if (share) p.set('openExternalBrowser', '1');
  return `${share ? location.origin : ''}${location.pathname}?${p}`;
}

function myColor(room) {
  const used = new Set(Object.values(room?.members || {}).map((m) => m.color));
  const pref = S.userData.color;
  if (pref && !used.has(pref)) return pref;
  return COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(room?.members || {}).length % COLORS.length];
}

function createRoom(name) {
  const id = rid(10);
  const me = uid();
  const color = myColor(null);
  const room = {
    name,
    createdBy: me,
    createdAt: serverTimestamp(),
    updatedAt: Date.now(),
    members: { [me]: { name: S.nick, color, joinedAt: Date.now(), away: false } },
    people: { [me]: { name: S.nick, color } },
    order: [me],
    settings: { shonben: false, shonbenRate: 0.05 },
    seq: 0,
    lastRound: null,
    ev: null,
  };
  startRound(room, 1);
  setDoc(doc(db, ROOMS, id), room).catch(fail);
  openRoom(id);
}

function leave() {
  S.unsubRoom?.();
  S.unsubChunks?.();
  S.unsubRoom = null;
  S.unsubChunks = null;
  S.roomId = null;
  S.room = null;
  S.queue = [];
  S.chunks = new Map();
  S.records = [];
  stopRolling(null);
  closeSheet();
  hideResult();
  unwake();
}

function openRoom(id) {
  leave();
  S.roomId = id;
  S.roomRef = doc(db, ROOMS, id);
  S.primed = false;
  S.joining = false;
  S.wasMember = false;
  S.leaving = false;
  S.recentName = null;
  S.shown = null;
  S.dicePos = null;
  $('#roomName').textContent = '';
  ls.set(`cc.lastRoom:${uid()}`, id);
  history.replaceState(null, '', roomUrl(id));
  show('room');
  S.unsubRoom = onSnapshot(S.roomRef, { includeMetadataChanges: true }, onRoom, (e) => {
    fail(e);
    if (e.code === 'permission-denied') roomGone();
  });
  S.unsubChunks = onSnapshot(collection(S.roomRef, 'chunks'), onChunks, () => {});
  setDoc(userRef(), { lastRoom: id }, { merge: true }).catch(() => {});
  wake();
}

function kicked() {
  const id = S.roomId;
  leave();
  ls.set(`cc.lastRoom:${uid()}`, '');
  setDoc(userRef(), { lastRoom: null, recent: { [id]: null } }, { merge: true }).catch(() => {});
  showMsg('ルームから外れました', 'もう一度入るには、招待リンクを開いてください。', [
    ['新しいルームを作る', () => createRoom(defaultRoomName())],
  ]);
}

function roomGone() {
  leave();
  ls.set(`cc.lastRoom:${uid()}`, '');
  showMsg('ルームが見つかりません', 'リンクが間違っているか、ルームが削除されています。', [
    ['新しいルームを作る', () => createRoom(defaultRoomName())],
  ]);
}

function onRoom(snap) {
  if (snap.ref.id !== S.roomId) return;
  const fromCache = snap.metadata.fromCache;
  if (!snap.exists()) { if (!fromCache && !S.leaving) roomGone(); return; }
  const data = snap.data({ serverTimestamps: 'estimate' });
  setSync(fromCache || snap.metadata.hasPendingWrites);
  const member = !!data.members?.[uid()];
  if (member) S.wasMember = true;
  if (!fromCache && !member && S.wasMember && !S.leaving) { kicked(); return; }
  if (!fromCache && !member && !S.joining && !S.leaving) join();
  if (!fromCache && S.recentName !== data.name) {
    S.recentName = data.name;
    setDoc(userRef(), { recent: { [S.roomId]: { name: data.name || '', at: Date.now() } } }, { merge: true }).catch(() => {});
  }
  S.queue.push({ data, fromCache });
  if (!S.busy) drain();
}

function onChunks(qs) {
  if (!S.roomRef || qs.query.parent?.id !== S.roomId) return;
  for (const ch of qs.docChanges()) {
    if (ch.type === 'removed') S.chunks.delete(ch.doc.id);
    else S.chunks.set(ch.doc.id, ch.doc.data().recs || []);
  }
  S.records = [...S.chunks.values()].flat().map((r) => ({ ...r, rolls: (r.rolls || []).map(dec) })).sort((a, b) => a.id - b.id);
  if (S.sheet === 'history' || S.sheet === 'stats') renderSheet(true);
}

let syncTimer = 0;
function setSync(pending) {
  clearTimeout(syncTimer);
  const d = $('#syncDot');
  if (!pending) { d.classList.remove('pending'); return; }
  syncTimer = setTimeout(() => d.classList.add('pending'), 1500);
}

/** ルームの更新を順番に処理する（振る演出が終わってから次の状態を反映） */
async function drain() {
  S.busy = true;
  while (S.queue.length) {
    const { data, fromCache } = S.queue.shift();
    const ev = data.ev;
    const fresh = S.primed && ev && ev.id !== S.lastEv;
    if (ev) S.lastEv = ev.id;
    if (!fromCache) S.primed = true;
    if (fresh && ev.kind === 'roll' && !document.hidden && S.room && S.queue.length < 3) await animateRoll(ev);
    else if (fresh && ev.kind === 'roll') S.shown = shownFromEv(ev);
    S.room = data;
    render();
    if (fresh) notify(ev, data);
  }
  S.busy = false;
}

function notify(ev, data) {
  if (ev.kind === 'skip' && prefs.toast) toast(`${esc(nameOf(ev.uid))}さんをスキップしました`);
  if (ev.round != null && data.lastRound?.round === ev.round) {
    vib([30, 60, 30]);
    showResult(data.lastRound);
  }
}

/* ---------- 書き込み（トランザクション） ---------- */
const recFields = (u) => ({ rank: u.rank, size: u.size, top: u.top, bottom: u.bottom });
function cleanRecord(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
  return out;
}

/** ルームを読み→fnで書き換え→記録を追加・順位を反映して保存。同時操作は自動でやり直される。 */
function mutate(fn) {
  const ref = S.roomRef;
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new GameError('ルームが見つかりません');
    const room = snap.data();
    const res = fn(room) || {};
    const ids = [...(res.record ? [res.record.id] : []), ...(res.rankUpdates || []).map((u) => u.id)];
    const keys = [...new Set(ids.map(chunkOf))];
    const chunks = {};
    for (const k of keys) {
      const s = await tx.get(chunkRef(ref, k));
      chunks[k] = s.exists() ? s.data().recs || [] : [];
    }
    if (res.record) chunks[chunkOf(res.record.id)].push(cleanRecord(res.record));
    for (const u of res.rankUpdates || []) {
      const r = chunks[chunkOf(u.id)].find((x) => x.id === u.id);
      if (r) Object.assign(r, recFields(u));
    }
    for (const k of keys) tx.set(chunkRef(ref, k), { k, recs: chunks[k] });
    if (res.record && (res.record.id - 1) % CHUNK === 0 && chunkOf(res.record.id) - KEEP_CHUNKS >= 0) {
      tx.delete(chunkRef(ref, chunkOf(res.record.id) - KEEP_CHUNKS));
    }
    tx.update(ref, {
      name: room.name, members: room.members, people: room.people || {}, order: room.order, settings: room.settings,
      game: room.game, lastRound: room.lastRound ?? null, seq: room.seq || 0, ev: room.ev ?? null, updatedAt: Date.now(),
    });
    return res;
  });
}

const evBase = (kind) => ({ id: rid(8), t: Date.now(), kind, by: uid() });
const withRoundEv = (room, res, kind = 'sync') => {
  if (res.roundEnd) room.ev = { ...evBase(kind), round: res.roundEnd.round };
  return res;
};

function join() {
  S.joining = true;
  mutate((room) => {
    if (room.members[uid()]) return {};
    if (Object.keys(room.members).length >= MAX_MEMBERS) throw new GameError(`このルームは満員です（最大${MAX_MEMBERS}人）`);
    const color = myColor(room);
    room.members[uid()] = { name: S.nick, color, joinedAt: Date.now(), away: false };
    room.people = { ...(room.people || {}), [uid()]: { name: S.nick, color } };
    room.order.push(uid());
    return withRoundEv(room, sync(room));
  }).then(() => toast('ルームに参加しました')).catch((e) => { S.joining = false; fail(e); });
}

/* ---------- プレイ画面 ---------- */
function shownFromEv(ev) {
  return { uid: ev.uid, dice: dec(ev.dice), hand: ev.hand, final: ev.final, sb: ev.sb, rollNo: ev.rollNo };
}

function render() {
  const r = S.room;
  if (!r) return;
  $('#roomName').textContent = r.name || '';
  const g = r.game;
  const turn = g.turn;
  const mine = turn?.uid === uid();
  const done = g.lineup.filter((u) => u in g.results).length;

  $('#roundNo').textContent = g.round;
  $('#roundCount').innerHTML = `${done}<small>/${g.lineup.length}</small>`;
  $('#prog').innerHTML = g.lineup.map((u) => `<i class="${u in g.results ? 'done' : u === turn?.uid ? 'now' : ''}" style="--c:${esc(colorOf(u))}"></i>`).join('');

  // 手番カード（その人の色）
  const tc = $('#turn');
  if (turn) {
    const c = colorOf(turn.uid);
    tc.style.setProperty('--c', c);
    tc.style.setProperty('--fg', fgFor(c));
    tc.className = `turn ${mine ? 'mine' : ''}`;
    tc.innerHTML = `<div class="t-text"><span class="t-label">${mine ? 'あなたの番' : 'いまの番'}</span><b class="t-name">${esc(nameOf(turn.uid))}</b></div>
      <div class="tries" aria-label="${turn.rolls.length}投目まで">${Array.from({ length: MAX_ROLLS }, (_, i) => `<i class="${i < turn.rolls.length ? 'used' : ''}"></i>`).join('')}</div>`;
  } else {
    tc.className = 'turn idle';
    tc.style.removeProperty('--c');
    tc.style.removeProperty('--fg');
    tc.innerHTML = '<div class="t-text"><span class="t-label">お休み中</span><b class="t-name">全員が休憩中です</b></div>';
  }

  // どんぶり：進行中のターンがあればその出目、なければ直前の結果
  if (!S.rolling) {
    let shown = S.shown;
    if (turn?.rolls.length) {
      shown = { uid: turn.uid, dice: dec(turn.rolls.at(-1)), hand: null, final: false, rollNo: turn.rolls.length };
    } else if (!shown) {
      const last = [...S.records].reverse().find((x) => x.h !== 'skip');
      if (last) shown = { uid: last.u, dice: last.rolls.at(-1), hand: last.h, final: true, sb: !!last.sb };
    }
    S.shown = shown;
    setDice(shown?.dice || [4, 5, 6], !shown);
    $('#hand').innerHTML = handHtml(shown);
    $('#hand').className = `hand ${shown ? `t-${shown.final ? tierOf(shown.hand) : 'mute'}` : 'idle'}`;
  }

  // 操作ボタン
  const busy = !!S.rolling;
  $('#controls').innerHTML = turn ? (mine
    ? `<button class="btn roll" data-act="roll" ${busy ? 'disabled' : ''}>サイコロを振る</button>
       <button class="link" data-act="skip" ${busy ? 'disabled' : ''}>今回はスキップ</button>`
    : `<div class="row2"><button class="btn ghost" data-act="proxy" ${busy ? 'disabled' : ''}>代わりに振る</button><button class="btn ghost" data-act="skip" ${busy ? 'disabled' : ''}>スキップ</button></div>
       <p class="wait">${esc(nameOf(turn.uid))}さんが振るのを待っています</p>`)
    : '<button class="btn ghost" data-act="members">休憩を解除する</button>';

  // この周の並び
  $('#lineup').innerHTML = g.lineup.map((u) => {
    const c = colorOf(u);
    const res = g.results[u];
    const m = r.members[u];
    let st;
    if (res) st = res.h === 'skip' ? 'スキップ' : handLabel(res.h);
    else if (turn?.uid === u) st = '振っています';
    else if (!m) st = '退会';
    else if (m.away) st = '休憩中';
    else st = '待ち';
    return `<div class="lu ${turn?.uid === u ? 'now' : ''} ${res ? 'done' : ''} ${res?.h === 'skip' || m?.away ? 'dim' : ''}" style="--c:${esc(c)};--fg:${fgFor(c)}">
      <b>${esc(nameOf(u))}</b><span>${esc(st)}</span></div>`;
  }).join('') || '<p class="wait">参加できるメンバーがいません</p>';

  if (S.sheet) refreshSheet();
}

function handHtml(shown) {
  if (!shown) return '<b>サイコロを振ろう</b><small>役が出るまで最大3回</small>';
  if (shown.final) {
    const sub = shown.sb ? 'どんぶりの外へ…' : esc(nameOf(shown.uid));
    return `<b>${esc(handLabel(shown.hand))}</b><small>${sub}</small>`;
  }
  return `<b>目なし</b><small>もう一度 · あと${MAX_ROLLS - (shown.rollNo || 0)}回</small>`;
}

const diceEls = () => [...document.querySelectorAll('#bowl .die')];
const BASE_POS = [[-22, -9, -14], [20, -12, 16], [-1, 17, 6]];
function setDice(dice, faded = false) {
  const pos = S.dicePos || BASE_POS;
  diceEls().forEach((el, i) => {
    el.dataset.v = dice[i];
    el.innerHTML = pips(dice[i]);
    el.classList.toggle('faded', faded);
    el.style.setProperty('--x', pos[i][0]);
    el.style.setProperty('--y', pos[i][1]);
    el.style.setProperty('--r', `${pos[i][2]}deg`);
  });
}

function scatter() {
  const base = [...BASE_POS].sort(() => Math.random() - 0.5);
  S.dicePos = base.map(([x, y]) => [Math.round(x + rnd(-6, 6)), Math.round(y + rnd(-5, 5)), Math.round(rnd(-40, 40))]);
  diceEls().forEach((el, i) => {
    el.style.setProperty('--x', S.dicePos[i][0]);
    el.style.setProperty('--y', S.dicePos[i][1]);
    el.style.setProperty('--r', `${S.dicePos[i][2]}deg`);
  });
}

function startRolling() {
  if (S.rolling) return;
  $('#hand').classList.add('hide');
  $('#bowl').classList.remove('glow-gold', 'glow-red');
  const els = diceEls();
  els.forEach((el, i) => { el.classList.remove('landed', 'faded'); el.classList.add('rolling'); el.style.animationDuration = `${0.26 + i * 0.05}s`; });
  const tick = () => {
    els.forEach((el) => { const v = 1 + Math.floor(Math.random() * 6); el.dataset.v = v; el.innerHTML = pips(v); });
    tone(rnd(820, 980), rnd(620, 760), 0.05, 0.08);
  };
  tick();
  scatter();
  S.rolling = { started: Date.now(), faces: setInterval(tick, 80), moves: setInterval(scatter, 240) };
  document.querySelectorAll('#controls button').forEach((b) => { b.disabled = true; });
}

function stopRolling(dice) {
  if (!S.rolling) return;
  clearInterval(S.rolling.faces);
  clearInterval(S.rolling.moves);
  S.rolling = null;
  diceEls().forEach((el, i) => {
    el.classList.remove('rolling');
    if (dice) { el.dataset.v = dice[i]; el.innerHTML = pips(dice[i]); }
    void el.offsetWidth;
    el.classList.add('landed');
  });
}

async function animateRoll(ev) {
  startRolling();
  const wait = ROLL_MIN_MS - (Date.now() - (S.rolling?.started || Date.now()));
  if (wait > 0) await sleep(wait);
  const shown = shownFromEv(ev);
  stopRolling(shown.dice);
  S.shown = shown;
  const h = $('#hand');
  h.innerHTML = handHtml(shown);
  h.className = `hand pop t-${shown.final ? tierOf(shown.hand) : 'mute'}`;
  if (shown.final) {
    handTone(shown.hand);
    const tier = tierOf(shown.hand);
    if (tier === 'gold') $('#bowl').classList.add('glow-gold');
    if (tier === 'red') $('#bowl').classList.add('glow-red');
    if (ev.uid === uid()) vib(tier === 'gold' ? [40, 60, 40] : 70);
  } else {
    tone(440, 400, 0.1, 0.12);
  }
  await sleep(shown.final ? 1300 : 600);
}

/** 前の人の演出が終わるまで待つ（演出中に押された操作を無視しないため） */
async function waitIdle(ms = 4000) {
  const end = Date.now() + ms;
  while ((S.busy || S.rolling) && Date.now() < end) await sleep(50);
}

async function doRoll(proxy) {
  if (S.rolling) return;
  await waitIdle();
  const turn = S.room?.game.turn;
  if (!turn || S.rolling || S.busy) return;
  if (!proxy && turn.uid !== uid()) return;
  if (proxy && !(await ask(`${nameOf(turn.uid)}さんの代わりに振りますか？\n出目は本人の記録として残ります。`, '代わりに振る'))) return;
  const key = turnKey(S.room);
  vib(12);
  startRolling();
  try {
    await mutate((room) => {
      const res = roll(room, uid(), key);
      room.ev = {
        ...evBase('roll'), uid: res.uid, dice: enc(res.dice), rollNo: res.rollNo, hand: res.hand,
        final: res.final, sb: res.sb, round: res.roundEnd?.round ?? null,
      };
      return res;
    });
  } catch (e) {
    stopRolling(null);
    fail(e);
    render();
  }
}

async function doSkip() {
  await waitIdle();
  const turn = S.room?.game.turn;
  if (!turn) return;
  const self = turn.uid === uid();
  const ok = await ask(self ? '今回の番をスキップしますか？' : `${nameOf(turn.uid)}さんを今回だけスキップしますか？\nしばらく抜けるときは、設定の「メンバー」で休憩にできます。`, 'スキップ');
  if (!ok) return;
  const key = turnKey(S.room);
  mutate((room) => {
    const res = skip(room, uid(), key);
    room.ev = { ...evBase('skip'), uid: res.uid, round: res.roundEnd?.round ?? null };
    return res;
  }).catch(fail);
}

/* ---------- 周の結果（全画面） ---------- */
let resultTimer = 0;
function showResult(rd) {
  const el = $('#result');
  const played = rd.entries.filter((e) => e.hand !== 'skip');
  const top = played.filter((e) => e.top);
  const lead = top[0] || (played.length === 1 ? played[0] : null);
  const c = lead ? colorOf(lead.uid) : '#1f1f24';
  el.style.setProperty('--c', c);
  el.style.setProperty('--fg', fgFor(c));
  const title = lead ? top.map((e) => nameOf(e.uid)).join('・') || nameOf(lead.uid) : '引き分け';
  const sub = lead ? `${handLabel(lead.hand)}${top.length ? 'で最強' : ''}` : '全員同じ強さでした';
  el.innerHTML = `<div class="rr">
    <p class="r-by">第${rd.round}周の結果</p>
    <p class="r-name">${esc(title)}</p>
    <p class="r-sub">${esc(sub)}</p>
    <ol class="r-list">${rd.entries.map((e) => `
      <li class="${e.top ? 'top' : ''} ${e.bottom ? 'bottom' : ''} ${e.hand === 'skip' ? 'skip' : ''}">
        <b class="r-rank">${e.rank ?? '–'}</b>${dot(colorOf(e.uid))}
        <span class="r-who">${esc(nameOf(e.uid))}${e.top ? '<em>最強</em>' : ''}${e.bottom ? '<em>最弱</em>' : ''}</span>
        <span class="r-hand">${e.hand === 'skip' ? 'スキップ' : esc(handLabel(e.hand))}</span>
        ${e.dice ? miniDice(dec(e.dice)) : ''}
      </li>`).join('')}</ol>
    <div class="r-btns"><button class="btn" data-act="closeResult">閉じる</button></div>
  </div>`;
  if (el.hidden) S.resultLayer = pushLayer(() => hideResult(true));
  el.hidden = false;
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => closeResult(), 12000);
}
function hideResult(fromPop = false) {
  clearTimeout(resultTimer);
  const el = $('#result');
  if (el.hidden) return;
  el.hidden = true;
  if (!fromPop) popLayerByUi(S.resultLayer);
}
const closeResult = () => hideResult(false);
$('#result').addEventListener('click', (e) => { if (e.target.closest('[data-act=closeResult]')) closeResult(); });

/* ---------- 確認ダイアログ ---------- */
function ask(text, ok = 'OK', danger = false) {
  const dlg = $('#ask');
  $('#askText').textContent = text;
  $('#askOk').textContent = ok;
  $('#askOk').classList.toggle('danger', danger);
  dlg.returnValue = '';
  dlg.showModal();
  const layer = pushLayer(() => dlg.close('no'));
  return new Promise((res) => dlg.addEventListener('close', () => {
    if (!S.closingByPop) popLayerByUi(layer);
    res(dlg.returnValue === 'ok');
  }, { once: true }));
}

/* ---------- シート ---------- */
const sheet = $('#sheet');
const inner = $('#sheetInner');
document.querySelector('.actions').addEventListener('click', (e) => {
  const a = e.target.closest('[data-open]')?.dataset.open;
  if (a) openSheet(a, a === 'settings' ? 'members' : undefined);
});
$('#roomTitle').onclick = () => openSheet('settings', 'room');
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => {
  S.sheet = null;
  S.palette = null;
  if (!S.closingByPop) popLayerByUi(S.sheetLayer);
});

function openSheet(name, tab) {
  if (!S.room) return;
  S.sheet = name;
  if (tab) S.tab = tab;
  if (name === 'stats' && !S.stats.member) S.stats.member = uid();
  renderSheet();
  if (!sheet.open) { sheet.showModal(); S.sheetLayer = pushLayer(() => sheet.close()); }
}
function closeSheet() { if (sheet.open) sheet.close(); }

const SET_TABS = [['members', 'メンバー'], ['rules', 'ルール'], ['room', 'ルーム'], ['device', 'この端末']];
const head = (title) => `<header class="s-head"><h2>${title}</h2><button class="ic" data-act="close" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>`;

function renderSheet(keepScroll = false) {
  const body = inner.querySelector('.s-body');
  const scroll = keepScroll && body ? body.scrollTop : 0;
  let html = '';
  if (S.sheet === 'settings') {
    html = head('設定') + `<div class="tabs" role="tablist">${SET_TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('')}</div>
      <div class="s-body">${{ members: membersHtml, rules: rulesHtml, room: roomHtml, device: deviceHtml }[S.tab]()}</div>`;
  } else if (S.sheet === 'share') {
    html = head('招待') + `<div class="s-body">${shareHtml()}</div>`;
  } else if (S.sheet === 'history') {
    html = head('記録') + `<div class="s-body">${historyHtml()}</div>`;
  } else if (S.sheet === 'stats') {
    html = head('分析') + '<div class="s-body stats"></div>';
  }
  inner.innerHTML = html;
  if (S.sheet === 'stats') {
    renderStats(inner.querySelector('.s-body'), {
      records: S.records, settings: S.room.settings, members: S.room.order.map((u) => ({ uid: u })),
      me: uid(), state: S.stats, person, nameOf, rerender: () => renderSheet(true),
    });
  }
  if (scroll) inner.querySelector('.s-body').scrollTop = scroll;
}

function refreshSheet() {
  if (S.sheet === 'settings' && (S.tab === 'members' || S.tab === 'rules')) renderSheet(true);
  else if (S.sheet === 'settings' && S.tab === 'room') {
    const n = $('#fRoomName');
    if (n && document.activeElement !== n) n.value = S.room.name || '';
  }
}

/* メンバー */
function membersHtml() {
  const r = S.room;
  return `<p class="hint">休憩をオンにすると、戻るまで順番を自動で飛ばします。1回だけ飛ばすときはプレイ画面の「スキップ」を使います。並び替えは、まだ誰も振っていない周ならすぐ、そうでなければ次の周から反映されます。</p>
    <ul class="mlist">${r.order.map((u, i) => {
      const m = r.members[u];
      return `<li class="mrow ${m.away ? 'away' : ''}" data-id="${esc(u)}">
        <span class="ord">${i + 1}</span>
        <button class="swatch" style="--c:${esc(m.color)}" data-act="color" aria-label="色を変える"></button>
        <span class="m-name">${esc(m.name)}${u === uid() || u === r.createdBy ? `<small>${[u === uid() ? 'あなた' : '', u === r.createdBy ? '作成者' : ''].filter(Boolean).join(' · ')}</small>` : ''}</span>
        <label class="m-away"><small>休憩</small><input type="checkbox" class="tg" data-f="away" ${m.away ? 'checked' : ''}></label>
        <span class="m-ord">
          <button class="ic sm" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="上へ"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button>
          <button class="ic sm" data-act="down" ${i === r.order.length - 1 ? 'disabled' : ''} aria-label="下へ"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
        </span>
        ${isOwner() && u !== uid() ? '<button class="ic sm danger" data-act="kick" aria-label="外す"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' : ''}
        ${S.palette === u ? `<div class="palette">${COLORS.map((c) => `<button style="--c:${c}" data-color="${c}" class="${c === m.color ? 'on' : ''}" aria-label="${c}"></button>`).join('')}</div>` : ''}
      </li>`;
    }).join('')}</ul>
    <button class="btn ghost" data-act="shuffle">順番をシャッフル</button>`;
}

/* ルール */
function rulesHtml() {
  const s = S.room.settings;
  const order = ['pinzoro', 'arashi6', 'shigoro', 'me6', 'me1', 'menashi', ...(s.shonben ? ['shonben'] : []), 'hifumi'];
  const note = { pinzoro: '1・1・1', arashi6: '2〜6のゾロ目（数字が大きいほど強い）', shigoro: '4・5・6', me6: '2つ同じ＋1つ違う → 違う数字が目', me1: '', menashi: '3投しても役なし', shonben: 'どんぶりから出て即負け', hifumi: '1・2・3' };
  return `<label class="row-tg"><span>ションベンあり<small>1投ごとに一定の確率でどんぶりの外へ（即負け）</small></span><input type="checkbox" class="tg" data-f="shonben" ${s.shonben ? 'checked' : ''}></label>
    ${s.shonben ? `<label class="lbl">ションベンになる確率（1投ごと）</label>
    <div class="seg">${[0.02, 0.03, 0.05, 0.08, 0.1].map((v) => `<button data-rate="${v}" class="${Math.abs(v - s.shonbenRate) < 1e-9 ? 'on' : ''}">${Math.round(v * 100)}%</button>`).join('')}</div>` : ''}
    <label class="lbl">役の強さ（上ほど強い）</label>
    <ol class="ranks">${order.map((h) => `<li>${handChip(h, h === 'arashi6' ? 'アラシ' : h === 'me6' ? '6の目〜' : h === 'me1' ? '〜1の目' : HANDS[h].label)}<small>${note[h]}</small></li>`).join('')}</ol>
    <p class="hint">役が出るまで最大${MAX_ROLLS}回振れます。サイコロは振った人の端末で暗号用の乱数を使って決めます。</p>`;
}

/* ルーム */
function roomHtml() {
  const recent = Object.entries(S.userData.recent || {})
    .filter(([id]) => id !== S.roomId).sort((a, b) => b[1].at - a[1].at).slice(0, 10);
  return `<label class="lbl" for="fRoomName">ルーム名</label>
    <input id="fRoomName" data-f="roomName" maxlength="24" value="${esc(S.room.name || '')}" autocomplete="off">
    <label class="lbl">新しく始める</label>
    <button class="btn" data-act="newRoom">新しいルームを作る</button>
    <label class="lbl">最近のルーム</label>
    <ul class="plist">${recent.length ? recent.map(([id, r]) => `<li data-id="${esc(id)}"><div class="p-main"><b>${esc(r.name || '無題')}</b><small>${fmtDate(r.at)}</small></div><button class="btn sm ghost" data-act="go">開く</button><button class="ic sm" data-act="forget" aria-label="一覧から消す"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`).join('') : '<li class="empty">ありません</li>'}</ul>
    <label class="lbl">このルーム</label>
    <button class="btn danger" data-act="leaveRoom">このルームから抜ける</button>
    ${isOwner() ? '<button class="btn danger" data-act="deleteRoom">ルームを削除（記録もすべて消えます）</button>' : ''}`;
}

/* この端末 */
function deviceHtml() {
  const tg = (k, label, sub = '', disabled = false) => `<label class="row-tg ${disabled ? 'off' : ''}"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="tg" data-pref="${k}" ${prefs[k] && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
  return `<label class="lbl" for="fNick">あなたの表示名<small>順番や記録に出る名前</small></label>
    <input id="fNick" data-f="nick" maxlength="12" value="${esc(S.nick)}" autocomplete="off">
    <label class="lbl">お知らせ</label>
    ${tg('vibrate', 'バイブレーション', CAN_VIBRATE ? '' : 'この端末のブラウザは非対応です（iPhoneなど）', !CAN_VIBRATE)}
    ${tg('sound', '効果音', 'マナーモード中は鳴らないことがあります')}
    ${tg('toast', '画面にお知らせを表示')}
    <label class="lbl">画面</label>
    ${tg('wake', '画面を消灯させない', 'ルームを開いている間だけ')}
    <label class="lbl">アカウント</label>
    <div class="acct"><span>${esc(S.user?.email || '')}</span><button class="btn sm ghost" data-act="logout">ログアウト</button></div>`;
}

/* 招待 */
function shareHtml() {
  const url = roomUrl(S.roomId, true);
  loadQr().then((qrcode) => {
    const box = $('#qrBox');
    if (!box || !qrcode) { box?.remove(); return; }
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  });
  return `<div class="qr" id="qrBox"></div>
    <p class="hint center">同じ席の人はQRを読み取り、離れた人にはリンクを送ってください。<br>開いてGoogleでログインすると、順番の最後に入ります。</p>
    <div class="url">${esc(url)}</div>
    <div class="stack">
      ${navigator.share ? '<button class="btn" data-act="nshare">リンクを送る</button>' : ''}
      <button class="btn ${navigator.share ? 'ghost' : ''}" data-act="copy">リンクをコピー</button>
    </div>`;
}
let qrPromise = null;
function loadQr() {
  if (!qrPromise) {
    qrPromise = new Promise((res) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
      sc.onload = () => res(window.qrcode || null);
      sc.onerror = () => { qrPromise = null; res(null); };
      document.head.appendChild(sc);
    });
  }
  return qrPromise;
}

/* 記録 */
function historyHtml() {
  const recs = S.records;
  const rounds = roundsOf(recs);
  const turns = recs.filter((r) => r.h !== 'skip').length;
  const ids = [...new Set([...S.room.order, ...recs.map((r) => r.u)])];
  const f = S.logMember;
  const row = (r, withRound) => `<li class="hrow">
    ${withRound ? `<span class="h-rno">第${r.r}周<small>${fmtTime(r.t)}</small></span>` : `${dot(colorOf(r.u))}<span class="h-who">${esc(nameOf(r.u))}</span>`}
    <span class="h-tags">${r.top ? '<em class="gold">最強</em>' : ''}${r.bottom ? '<em class="red">最弱</em>' : ''}${r.by ? `<small>${esc(nameOf(r.by))}が${r.h === 'skip' ? 'スキップ' : '代理'}</small>` : ''}</span>
    <span class="h-res">${r.h === 'skip' ? '<small>スキップ</small>' : `${handChip(r.h)}<span class="h-rolls">${r.rolls.map((x, i) => miniDice(x, i < r.rolls.length - 1 ? 'past' : '')).join('')}</span>`}</span>
  </li>`;
  let body;
  if (!recs.length) body = '<p class="empty-note">まだ記録がありません。サイコロを振るとここに残ります。</p>';
  else if (f) {
    const mine = recs.filter((r) => r.u === f).reverse().slice(0, S.logLimit * 3);
    body = `<ul class="hlist">${mine.map((r) => row(r, true)).join('') || '<li class="empty">記録がありません</li>'}</ul>`;
  } else {
    body = rounds.slice(0, S.logLimit).map((rd) => `<section class="hround">
      <header><b>第${rd.round}周</b>${rd.round === S.room.game.round ? '<em>進行中</em>' : ''}<time>${fmtDate(rd.at)}</time></header>
      <ul class="hlist">${[...rd.records].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.id - b.id).map((r) => row(r, false)).join('')}</ul>
    </section>`).join('');
  }
  const more = f ? recs.filter((r) => r.u === f).length > S.logLimit * 3 : rounds.length > S.logLimit;
  return `<p class="hint">${rounds.length}周 · ${turns}ターン（最新1000件ほどを保存）</p>
    <div class="chips">
      <button class="chip ${f ? '' : 'on'}" data-log="">全員</button>
      ${ids.map((u) => `<button class="chip ${f === u ? 'on' : ''}" data-log="${esc(u)}">${dot(colorOf(u))}${esc(nameOf(u))}</button>`).join('')}
    </div>
    ${body}
    ${more ? '<button class="btn ghost" data-act="more">もっと見る</button>' : ''}`;
}

/* ---------- シート内の操作 ---------- */
function moveOrder(u, d) {
  mutate((room) => {
    const i = room.order.indexOf(u);
    const j = i + d;
    if (i < 0 || j < 0 || j >= room.order.length) return {};
    [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
    return withRoundEv(room, sync(room));
  }).catch(fail);
}

function removeMember(u) {
  return mutate((room) => {
    if (!room.members[u]) return {};
    delete room.members[u];
    room.order = room.order.filter((x) => x !== u);
    return withRoundEv(room, sync(room));
  });
}

async function deleteRoom() {
  if (!(await ask(`「${S.room.name}」と、すべての記録を削除します。元に戻せません。`, '削除する', true))) return;
  const ref = S.roomRef;
  S.leaving = true;
  try {
    const chunks = await getDocs(collection(ref, 'chunks'));
    const b = writeBatch(db);
    chunks.forEach((d) => b.delete(d.ref));
    b.delete(ref);
    await b.commit();
    ls.set(`cc.lastRoom:${uid()}`, '');
    leave();
    createRoom(defaultRoomName());
    toast('ルームを削除しました');
  } catch (e) { S.leaving = false; fail(e); }
}

function setMyName(v) {
  S.nick = v;
  ls.set(`cc.nick:${uid()}`, v);
  setDoc(userRef(), { nick: v }, { merge: true }).catch(() => {});
  if (S.room?.members[uid()]) {
    mutate((room) => {
      if (!room.members[uid()]) return {};
      room.members[uid()].name = v;
      room.people = { ...(room.people || {}), [uid()]: { ...room.members[uid()] } };
      return {};
    }).catch(fail);
  }
}

inner.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab) { S.tab = tab; S.palette = null; renderSheet(); return; }
  const logBtn = e.target.closest('[data-log]');
  if (logBtn) { S.logMember = logBtn.dataset.log || null; S.logLimit = 15; renderSheet(); return; }
  const rate = e.target.closest('[data-rate]')?.dataset.rate;
  if (rate) { mutate((room) => { room.settings.shonbenRate = Number(rate); return {}; }).catch(fail); return; }
  const color = e.target.closest('[data-color]')?.dataset.color;
  if (color) {
    const u = e.target.closest('.mrow')?.dataset.id;
    S.palette = null;
    if (u === uid()) setDoc(userRef(), { color }, { merge: true }).catch(() => {});
    mutate((room) => {
      if (!room.members[u]) return {};
      room.members[u].color = color;
      room.people = { ...(room.people || {}), [u]: { ...room.members[u] } };
      return {};
    }).catch(fail);
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const rowId = e.target.closest('[data-id]')?.dataset.id;
  if (act === 'close') closeSheet();
  else if (act === 'color') { S.palette = S.palette === rowId ? null : rowId; renderSheet(true); }
  else if (act === 'up') moveOrder(rowId, -1);
  else if (act === 'down') moveOrder(rowId, 1);
  else if (act === 'shuffle') {
    mutate((room) => {
      const o = room.order;
      for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
      return withRoundEv(room, sync(room));
    }).then(() => toast('順番をシャッフルしました')).catch(fail);
  } else if (act === 'kick') {
    if (await ask(`${nameOf(rowId)}さんをルームから外しますか？\nこれまでの記録は残ります。`, '外す', true)) removeMember(rowId).catch(fail);
  } else if (act === 'newRoom') {
    if (await ask('新しいルームを作りますか？\n今のルームは「最近のルーム」から開けます。', '作る')) { closeSheet(); createRoom(defaultRoomName()); }
  } else if (act === 'go') { closeSheet(); openRoom(rowId); }
  else if (act === 'forget') {
    setDoc(userRef(), { recent: { [rowId]: null } }, { merge: true }).catch(() => {});
    S.userData.recent && delete S.userData.recent[rowId];
    renderSheet(true);
  } else if (act === 'leaveRoom') {
    if (!(await ask('このルームから抜けますか？\nもう一度入るには招待リンクが必要です。', '抜ける', true))) return;
    S.leaving = true;
    try {
      await removeMember(uid());
      ls.set(`cc.lastRoom:${uid()}`, '');
      setDoc(userRef(), { lastRoom: null, recent: { [S.roomId]: null } }, { merge: true }).catch(() => {});
      leave();
      createRoom(defaultRoomName());
    } catch (err) { S.leaving = false; fail(err); }
  } else if (act === 'deleteRoom') deleteRoom();
  else if (act === 'logout') { closeSheet(); signOut(auth); }
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(roomUrl(S.roomId, true)); toast('リンクをコピーしました'); } catch { toast('コピーできませんでした'); }
  } else if (act === 'nshare') {
    try { await navigator.share({ title: S.room.name, text: `チンチロ「${S.room.name}」に参加しよう`, url: roomUrl(S.roomId, true) }); } catch { /* キャンセル */ }
  } else if (act === 'more') { S.logLimit += 20; renderSheet(true); }
});

inner.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.pref) {
    prefs[t.dataset.pref] = t.checked;
    savePrefs();
    if (t.dataset.pref === 'wake') { if (t.checked) wake(); else unwake(); }
    if (t.dataset.pref === 'sound' && t.checked) { audio(); setTimeout(() => tone(620, 980), 60); }
    if (t.dataset.pref === 'vibrate' && t.checked) vib(60);
    return;
  }
  const f = t.dataset.f;
  if (f === 'away') {
    const u = t.closest('.mrow').dataset.id;
    mutate((room) => {
      if (!room.members[u]) return {};
      room.members[u].away = t.checked;
      return withRoundEv(room, sync(room));
    }).catch(fail);
  } else if (f === 'shonben') {
    mutate((room) => { room.settings.shonben = t.checked; return {}; }).catch(fail);
  } else if (f === 'roomName') {
    const v = t.value.trim();
    if (v && v !== S.room.name) mutate((room) => { room.name = v.slice(0, 24); return {}; }).catch(fail);
    else t.value = S.room.name || '';
  } else if (f === 'nick') {
    const v = t.value.trim().slice(0, 12);
    if (!v) { t.value = S.nick; return; }
    setMyName(v);
  }
});
inner.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-f]')) e.target.blur();
});

/* ---------- プレイ画面の操作 ---------- */
$('#controls').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'roll') doRoll(false);
  else if (act === 'proxy') doRoll(true);
  else if (act === 'skip') doSkip();
  else if (act === 'members') openSheet('settings', 'members');
});

start();
