import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, filterRecords, buildMetrics, rankBy, headToHead, faceBias, dayStart, insights } from '../public/js/analysis.js';

const rec = (id, u, h, extra = {}) => ({ id, r: Math.ceil(id / 2), u, h, t: id * 1000, rolls: [[4, 5, 6]], ...extra });

test('連続・条件付き確率', () => {
  const records = [rec(1, 'a', 'hifumi'), rec(2, 'b', 'hifumi'), rec(3, 'a', 'hifumi'), rec(4, 'b', 'me3'), rec(5, 'a', 'shigoro'), rec(6, 'b', 'skip', { rolls: [] })];
  const { users, total } = analyze(records);
  const a = users.find((u) => u.uid === 'a');
  assert.equal(a.n, 3);
  assert.deepEqual(a.after.hifumi, { prev: 2, again: 1 });
  assert.equal(a.samePairs, 1);
  const b = users.find((u) => u.uid === 'b');
  assert.equal(b.skips, 1);
  assert.deepEqual(total.after.hifumi, { prev: 3, again: 1 });
});

test('期間フィルター', () => {
  const records = Array.from({ length: 150 }, (_, i) => rec(i + 1, 'a', 'me3'));
  assert.equal(filterRecords(records, 'last100').length, 100);
  assert.equal(filterRecords(records, 'last10rounds').length, 20);
  const now = new Date(2026, 9, 31, 2, 0).getTime(); // 深夜2時は前日扱い
  assert.equal(new Date(dayStart(now)).getDate(), 30);
});

test('ランキングと対戦成績', () => {
  const records = [];
  let id = 0;
  for (let r = 1; r <= 6; r++) {
    records.push({ id: ++id, r, u: 'a', h: 'shigoro', t: id, rolls: [[4, 5, 6]], rank: 1, size: 2, top: true });
    records.push({ id: ++id, r, u: 'b', h: 'me2', t: id, rolls: [[2, 2, 2]], rank: 2, size: 2, bottom: true });
  }
  const res = analyze(records);
  const metric = buildMetrics({ shonben: false }).find((m) => m.key === 'hand:shigoro');
  const { rows } = rankBy(metric, res.users);
  assert.equal(rows[0].uid, 'a');
  assert.equal(rows[0].value, 1);
  assert.deepEqual(headToHead(records).a.b, { w: 6, l: 0, d: 0 });
  assert.ok(insights(res, {}, (u) => u).length > 0);
});

test('サイコロの偏り検定', () => {
  assert.ok(faceBias([10, 10, 10, 10, 10, 10]).p > 0.99);
  assert.ok(faceBias([40, 5, 5, 5, 5, 5]).p < 0.001);
});
