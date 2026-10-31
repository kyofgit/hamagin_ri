import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRound, roll, skip, sync, turnKey, defaultRng } from '../public/js/game.js';

function makeRoom(uids) {
  const room = { members: {}, order: [], settings: { shonben: false, shonbenRate: 0.05 }, seq: 0, lastRound: null };
  for (const u of uids) { room.members[u] = { name: u, color: '#fff', joinedAt: 0, away: false }; room.order.push(u); }
  startRound(room, 1);
  return room;
}
const seqRng = (dice) => { let i = 0; return { die: () => dice[i++ % dice.length], chance: () => 1 }; };

test('役が出るまで最大3投、周が終わると順位がつく', () => {
  const room = makeRoom(['a', 'b', 'c']);
  roll(room, 'a', turnKey(room), seqRng([1, 3, 5]));
  roll(room, 'a', turnKey(room), seqRng([1, 3, 5]));
  const r3 = roll(room, 'a', turnKey(room), seqRng([1, 3, 5]));
  assert.equal(r3.record.h, 'menashi');
  assert.deepEqual(r3.record.rolls, ['135', '135', '135']);
  assert.equal(room.game.turn.uid, 'b');
  assert.equal(roll(room, 'b', turnKey(room), seqRng([4, 5, 6])).record.h, 'shigoro');
  const s = skip(room, 'a', turnKey(room));
  assert.equal(s.record.by, 'a');
  assert.equal(s.roundEnd.round, 1);
  assert.deepEqual(s.roundEnd.entries.map((e) => [e.uid, e.rank, e.top, e.bottom]), [['b', 1, true, false], ['a', 2, false, true], ['c', null, false, false]]);
  assert.deepEqual(s.rankUpdates.map((u) => [u.id, u.rank, u.size]).sort(), [[1, 2, 2], [2, 1, 2]]);
  assert.equal(room.game.round, 2);
  assert.equal(room.game.turn.uid, 'a');
});

test('古い手番キーでは振れない（二重押し防止）', () => {
  const room = makeRoom(['a', 'b']);
  const key = turnKey(room);
  roll(room, 'a', key, seqRng([4, 5, 6]));
  assert.throws(() => roll(room, 'a', key, seqRng([4, 5, 6])), /状態が変わりました/);
});

test('休憩中の人は飛ばし、まだ誰も振っていなければ並びを作り直す', () => {
  const room = makeRoom(['a', 'b', 'c']);
  room.members.a.away = true;
  sync(room);
  assert.deepEqual(room.game.lineup, ['b', 'c']);
  roll(room, 'b', turnKey(room), seqRng([4, 5, 6]));
  room.members.c.away = true;
  const done = sync(room);
  assert.equal(done.roundEnd.entries.length, 1);
  assert.equal(room.game.round, 2);
  assert.deepEqual(room.game.lineup, ['b']);
  room.members.a.away = false;
  sync(room);
  assert.deepEqual(room.game.lineup, ['a', 'b']);
});

test('ションベン', () => {
  const room = makeRoom(['a']);
  room.settings.shonben = true;
  const r = roll(room, 'a', turnKey(room), { die: () => 4, chance: () => 0 });
  assert.equal(r.record.h, 'shonben');
  assert.equal(r.record.sb, true);
});

test('乱数は1〜6を一様に出す', () => {
  const c = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 60000; i++) c[defaultRng.die() - 1]++;
  for (const n of c) assert.ok(Math.abs(n - 10000) < 500, String(c));
});
