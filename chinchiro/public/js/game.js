// 手番・周・スキップ・休憩の進行ロジック（純粋関数）。
// Firestore のトランザクション内でルームのデータを書き換え、追加・更新する記録を返す。
// 出目は Firestore の制約（配列の入れ子不可）に合わせて "135" のような3桁の文字列で持つ。
import { evaluate, strengthOf, MAX_ROLLS } from './rules.js';

export class GameError extends Error {}

export const enc = (dice) => dice.join('');
export const dec = (s) => [...String(s)].map(Number);

function randomInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}
export const defaultRng = {
  die: () => 1 + randomInt(6),
  chance: () => randomInt(1_000_000) / 1_000_000,
};

const isActive = (room, uid) => !!room.members[uid] && !room.members[uid].away;
export const activeOrder = (room) => room.order.filter((uid) => isActive(room, uid));

export function turnKey(room) {
  const g = room.game;
  return g.turn ? `${g.round}-${g.idx}-${g.turn.rolls.length}` : null;
}

function setTurnAt(room, idx) {
  const g = room.game;
  g.idx = idx;
  while (g.idx < g.lineup.length) {
    const uid = g.lineup[g.idx];
    if (isActive(room, uid) && !(uid in g.results)) {
      g.turn = { uid, rolls: [] };
      return;
    }
    g.idx++;
  }
  g.turn = null;
}

export function startRound(room, round) {
  room.game = { round, lineup: activeOrder(room), idx: 0, turn: null, results: {} };
  setTurnAt(room, 0);
}

const untouched = (g) => Object.keys(g.results).length === 0 && (!g.turn || g.turn.rolls.length === 0);

function newRecord(room, rec, now) {
  room.seq = (room.seq || 0) + 1;
  const record = { id: room.seq, r: room.game.round, t: now, ...rec };
  room.game.results[rec.u] = { id: record.id, h: rec.h, d: rec.rolls.at(-1) || '' };
  return record;
}

/** 周の終了。順位を計算して lastRound を更新し、記録に書き込む順位情報を返す。 */
function finishRound(room, now) {
  const g = room.game;
  const entries = g.lineup.filter((uid) => uid in g.results).map((uid) => ({ uid, ...g.results[uid] }));
  if (!entries.length) return { roundEnd: null, rankUpdates: [] };
  const played = entries.filter((e) => e.h !== 'skip');
  const ss = played.map((e) => strengthOf(e.h));
  const max = Math.max(...ss);
  const min = Math.min(...ss);
  const rankUpdates = played.map((e) => {
    const s = strengthOf(e.h);
    return {
      id: e.id,
      rank: 1 + ss.filter((x) => x > s).length,
      size: played.length,
      top: played.length >= 2 && max > min && s === max,
      bottom: played.length >= 2 && max > min && s === min,
    };
  });
  const byId = Object.fromEntries(rankUpdates.map((u) => [u.id, u]));
  const ordered = [...played].sort((a, b) => byId[a.id].rank - byId[b.id].rank || g.lineup.indexOf(a.uid) - g.lineup.indexOf(b.uid));
  const roundEnd = {
    round: g.round,
    at: now,
    entries: [...ordered, ...entries.filter((e) => e.h === 'skip')].map((e) => ({
      id: e.id, uid: e.uid, hand: e.h, dice: e.d, rank: byId[e.id]?.rank ?? null, top: !!byId[e.id]?.top, bottom: !!byId[e.id]?.bottom,
    })),
  };
  room.lastRound = roundEnd;
  return { roundEnd, rankUpdates };
}

function advance(room, now) {
  const g = room.game;
  setTurnAt(room, g.idx + 1);
  if (g.turn) return { roundEnd: null, rankUpdates: [] };
  const done = finishRound(room, now);
  startRound(room, g.round + 1);
  return done;
}

function assertTurn(room, key) {
  if (!room.game.turn) throw new GameError('いまは誰の番でもありません');
  if (key !== turnKey(room)) throw new GameError('ほかの人の操作で状態が変わりました');
}

/** サイコロを振る。actor が手番の人以外なら代理振り。 */
export function roll(room, actor, key, rng = defaultRng, now = Date.now()) {
  assertTurn(room, key);
  const turn = room.game.turn;
  const dice = [rng.die(), rng.die(), rng.die()];
  const sb = !!room.settings?.shonben && rng.chance() < room.settings.shonbenRate;
  turn.rolls.push(enc(dice));
  const hand = sb ? 'shonben' : evaluate(dice);
  const out = { uid: turn.uid, dice, rollNo: turn.rolls.length, sb, hand, final: false, record: null, roundEnd: null, rankUpdates: [] };
  if (!hand && turn.rolls.length < MAX_ROLLS) return out;

  const rec = { u: turn.uid, rolls: [...turn.rolls], h: hand || 'menashi' };
  if (sb) rec.sb = true;
  if (actor !== turn.uid) rec.by = actor;
  out.hand = rec.h;
  out.final = true;
  out.record = newRecord(room, rec, now);
  return Object.assign(out, advance(room, now));
}

/** 手番の人を今回だけスキップ */
export function skip(room, actor, key, now = Date.now()) {
  assertTurn(room, key);
  const uid = room.game.turn.uid;
  const rec = { u: uid, rolls: [], h: 'skip' };
  if (actor !== uid) rec.by = actor;
  const record = newRecord(room, rec, now);
  return { uid, record, ...advance(room, now) };
}

/**
 * メンバー・順番・休憩が変わったときに呼ぶ。
 * まだ誰も振っていない周なら並びを作り直し、手番の人が抜けたら次へ進める。
 */
export function sync(room, now = Date.now()) {
  const g = room.game;
  if (untouched(g)) {
    startRound(room, g.round);
    return { roundEnd: null, rankUpdates: [] };
  }
  if (g.turn && !isActive(room, g.turn.uid)) {
    g.turn = null;
    setTurnAt(room, g.idx);
    if (!g.turn) {
      const done = finishRound(room, now);
      startRound(room, g.round + 1);
      return done;
    }
  }
  return { roundEnd: null, rankUpdates: [] };
}
