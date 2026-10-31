import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRound, roll, skip, sync, turnKey } from '../server/game.js';
import { MAX_RECORDS } from '../public/js/rules.js';

function makeGroup(uids) {
  const g = { members: {}, order: [], settings: { shonben: false, shonbenRate: 0.05 }, records: [], seq: 0, lastRound: null };
  for (const u of uids) { g.members[u] = { joinedAt: 0, away: false }; g.order.push(u); }
  startRound(g, 1);
  return g;
}
const seqRng = (dice) => { let i = 0; return { die: () => dice[i++ % dice.length], chance: () => 1 }; };

test('役が出るまで最大3投、周が終わると順位がつく', () => {
  const g = makeGroup(['a', 'b', 'c']);
  // a: 目なし→目なし→目なし（3投で終了）
  roll(g, 'a', turnKey(g), seqRng([1, 3, 5]));
  roll(g, 'a', turnKey(g), seqRng([1, 3, 5]));
  const r3 = roll(g, 'a', turnKey(g), seqRng([1, 3, 5]));
  assert.equal(r3.record.h, 'menashi');
  assert.equal(g.game.turn.uid, 'b');
  // b: 1投目でシゴロ
  assert.equal(roll(g, 'b', turnKey(g), seqRng([4, 5, 6])).record.h, 'shigoro');
  // c: スキップ（a が代理で操作）
  const s = skip(g, 'a', turnKey(g));
  assert.equal(s.record.by, 'a');
  assert.equal(s.roundEnd.round, 1);
  assert.deepEqual(s.roundEnd.entries.map((e) => [e.uid, e.rank, e.top, e.bottom]), [['b', 1, true, false], ['a', 2, false, true], ['c', null, false, false]]);
  assert.equal(g.game.round, 2);
  assert.equal(g.game.turn.uid, 'a');
});

test('古い手番キーでは振れない（二重押し防止）', () => {
  const g = makeGroup(['a', 'b']);
  const key = turnKey(g);
  roll(g, 'a', key, seqRng([4, 5, 6]));
  assert.throws(() => roll(g, 'a', key, seqRng([4, 5, 6])), /状態が更新/);
});

test('休憩中の人は飛ばし、まだ誰も振っていなければ並びを作り直す', () => {
  const g = makeGroup(['a', 'b', 'c']);
  g.members.a.away = true;
  sync(g);
  assert.deepEqual(g.game.lineup, ['b', 'c']);
  roll(g, 'b', turnKey(g), seqRng([4, 5, 6]));
  g.members.c.away = true; // 手番の人が離脱 → 周が終わる
  const done = sync(g);
  assert.equal(done.roundEnd.entries.length, 1);
  assert.equal(g.game.round, 2);
  assert.deepEqual(g.game.lineup, ['b']);
  g.members.a.away = false;
  sync(g);
  assert.deepEqual(g.game.lineup, ['a', 'b']);
});

test('ションベン', () => {
  const g = makeGroup(['a']);
  g.settings.shonben = true;
  const r = roll(g, 'a', turnKey(g), { die: () => 4, chance: () => 0 });
  assert.equal(r.record.h, 'shonben');
  assert.equal(r.record.sb, true);
});

test(`記録は最新${MAX_RECORDS}件まで`, () => {
  const g = makeGroup(['a']);
  for (let i = 0; i < MAX_RECORDS + 50; i++) roll(g, 'a', turnKey(g), seqRng([4, 5, 6]));
  assert.equal(g.records.length, MAX_RECORDS);
  assert.equal(g.records[0].id, 51);
});
