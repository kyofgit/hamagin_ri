// ゲーム進行ロジック。グループオブジェクトを直接書き換える純粋なロジックで、保存・通信は呼び出し側が行う。
import { randomInt } from 'node:crypto';
import { evaluate, strengthOf, MAX_ROLLS, MAX_RECORDS } from '../public/js/rules.js';

export class GameError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const defaultRng = {
  die: () => randomInt(1, 7),
  chance: () => randomInt(0, 1_000_000) / 1_000_000,
};

const isActive = (group, uid) => !!group.members[uid] && !group.members[uid].away;

export function activeOrder(group) {
  return group.order.filter((uid) => isActive(group, uid));
}

export function turnKey(group) {
  const g = group.game;
  if (!g.turn) return null;
  return `${g.round}-${g.idx}-${g.turn.rolls.length}`;
}

function setTurnAt(group, idx) {
  const g = group.game;
  g.idx = idx;
  while (g.idx < g.lineup.length) {
    const uid = g.lineup[g.idx];
    if (isActive(group, uid) && !(uid in g.results)) {
      g.turn = { uid, rolls: [] };
      return;
    }
    g.idx++;
  }
  g.turn = null;
}

export function startRound(group, round) {
  group.game = { round, lineup: activeOrder(group), idx: 0, turn: null, results: {}, startedAt: Date.now() };
  setTurnAt(group, 0);
}

const roundUntouched = (g) => Object.keys(g.results).length === 0 && (!g.turn || g.turn.rolls.length === 0);

function pushRecord(group, rec) {
  group.seq = (group.seq || 0) + 1;
  const record = { id: group.seq, r: group.game.round, t: Date.now(), ...rec };
  group.records.push(record);
  if (group.records.length > MAX_RECORDS) group.records.splice(0, group.records.length - MAX_RECORDS);
  group.game.results[rec.u] = record.id;
  return record;
}

function findRecord(group, id) {
  for (let i = group.records.length - 1; i >= 0; i--) if (group.records[i].id === id) return group.records[i];
  return null;
}

/** 周の終了処理。順位を記録に書き込み、周の結果を返す。 */
function finishRound(group) {
  const g = group.game;
  const recs = g.lineup.filter((uid) => uid in g.results).map((uid) => findRecord(group, g.results[uid])).filter(Boolean);
  if (recs.length === 0) return { roundEnd: null, updated: [] };
  const played = recs.filter((r) => r.h !== 'skip');
  const strengths = played.map((r) => strengthOf(r.h));
  const max = Math.max(...strengths);
  const min = Math.min(...strengths);
  for (const r of played) {
    const s = strengthOf(r.h);
    r.rank = 1 + strengths.filter((x) => x > s).length;
    r.size = played.length;
    r.top = played.length >= 2 && max > min && s === max;
    r.bottom = played.length >= 2 && max > min && s === min;
  }
  const entries = [...played].sort((a, b) => a.rank - b.rank || g.lineup.indexOf(a.u) - g.lineup.indexOf(b.u));
  for (const r of recs) if (r.h === 'skip') entries.push(r);
  const roundEnd = {
    round: g.round,
    at: Date.now(),
    entries: entries.map((r) => ({ id: r.id, uid: r.u, hand: r.h, dice: r.rolls.at(-1) || null, sb: !!r.sb, rank: r.rank ?? null, top: !!r.top, bottom: !!r.bottom })),
  };
  group.lastRound = roundEnd;
  return { roundEnd, updated: played };
}

/** 次の手番へ。周が終わったら結果を確定して次の周を始める。 */
function advance(group) {
  const g = group.game;
  setTurnAt(group, g.idx + 1);
  if (g.turn) return { roundEnd: null, updated: [] };
  const done = finishRound(group);
  startRound(group, g.round + 1);
  return done;
}

function assertTurn(group, key) {
  if (!group.game.turn) throw new GameError('いまは誰の番でもありません');
  if (key !== turnKey(group)) throw new GameError('状態が更新されました。画面を確認してください');
}

/** サイコロを振る。actorId が手番の人以外なら代理振り。 */
export function roll(group, actorId, key, rng = defaultRng) {
  assertTurn(group, key);
  const turn = group.game.turn;
  const dice = [rng.die(), rng.die(), rng.die()];
  const shonben = !!group.settings.shonben && rng.chance() < group.settings.shonbenRate;
  turn.rolls.push(dice);
  const hand = shonben ? 'shonben' : evaluate(dice);
  const result = { uid: turn.uid, dice, rollNo: turn.rolls.length, shonben, hand, record: null, roundEnd: null, updated: [] };
  if (!hand && turn.rolls.length < MAX_ROLLS) return result;

  const rec = { u: turn.uid, rolls: turn.rolls, h: hand || 'menashi' };
  if (shonben) rec.sb = true;
  if (actorId !== turn.uid) rec.by = actorId;
  result.hand = rec.h;
  result.record = pushRecord(group, rec);
  Object.assign(result, advance(group));
  return result;
}

/** 手番の人を今回だけスキップする */
export function skip(group, actorId, key) {
  assertTurn(group, key);
  const turn = group.game.turn;
  const rec = { u: turn.uid, rolls: [], h: 'skip' };
  if (actorId !== turn.uid) rec.by = actorId;
  const record = pushRecord(group, rec);
  return { uid: turn.uid, record, ...advance(group) };
}

/**
 * メンバー構成・順番・休憩状態が変わったときに呼ぶ。
 * まだ誰も振っていない周なら並びを作り直し、手番の人がいなくなったら次へ進める。
 */
export function sync(group) {
  const g = group.game;
  if (roundUntouched(g)) {
    startRound(group, g.round);
    return { roundEnd: null, updated: [] };
  }
  if (g.turn && !isActive(group, g.turn.uid)) {
    g.turn = null;
    setTurnAt(group, g.idx);
    if (!g.turn) {
      const done = finishRound(group);
      startRound(group, g.round + 1);
      return done;
    }
  }
  return { roundEnd: null, updated: [] };
}
