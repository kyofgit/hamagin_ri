import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, theoreticalHandProbs, theoreticalFor, strengthOf } from '../public/js/rules.js';

test('役判定', () => {
  assert.equal(evaluate([1, 1, 1]), 'pinzoro');
  assert.equal(evaluate([5, 5, 5]), 'arashi5');
  assert.equal(evaluate([6, 4, 5]), 'shigoro');
  assert.equal(evaluate([3, 1, 2]), 'hifumi');
  assert.equal(evaluate([2, 5, 2]), 'me5');
  assert.equal(evaluate([6, 6, 1]), 'me1');
  assert.equal(evaluate([1, 3, 5]), null);
});

test('216通りの内訳', () => {
  const c = {};
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let d = 1; d <= 6; d++) {
    const h = evaluate([a, b, d]) ?? 'none';
    c[h] = (c[h] || 0) + 1;
  }
  assert.equal(c.pinzoro, 1);
  assert.equal(c.shigoro, 6);
  assert.equal(c.hifumi, 6);
  assert.equal(c.me4, 15);
  assert.equal(c.none, 108);
});

test('理論確率（1ターン最大3投）', () => {
  const p = theoreticalHandProbs(0);
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.ok(Math.abs(p.menashi - 0.125) < 1e-12);
  assert.ok(Math.abs(p.pinzoro - 1.75 / 216) < 1e-12);
  assert.ok(Math.abs(theoreticalFor(['shigoro']) - 10.5 / 216) < 1e-12);
  const ps = theoreticalHandProbs(0.05);
  assert.ok(Math.abs(Object.values(ps).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(ps.shonben > 0.05);
});

test('強さの順序', () => {
  const order = ['pinzoro', 'arashi6', 'arashi2', 'shigoro', 'me6', 'me1', 'menashi', 'shonben', 'hifumi'];
  for (let i = 1; i < order.length; i++) assert.ok(strengthOf(order[i - 1]) > strengthOf(order[i]), order[i]);
});
