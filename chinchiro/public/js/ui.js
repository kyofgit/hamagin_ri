// 画面部品の小物（エスケープ・色・サイコロ・役ラベル・日時）
import { handLabel } from './rules.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export const COLORS = ['#FF6B57', '#FFD23F', '#3DD9A4', '#5C7CFF', '#FF6FB5', '#FF9F43',
  '#4DB8FF', '#B5E655', '#9B6BFF', '#EDE8DF', '#22C3C9', '#3A3A42'];

/** 背景色に対して読みやすい文字色（マルチカウンターと同じ判定） */
export const fgFor = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.36 ? '#121214' : '#FAF8F4';
};

export const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const fmtDate = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(ms)}`; };

export const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(d)}%`);

const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
export const pips = (v) => Array.from({ length: 9 }, (_, i) => (PIPS[v]?.includes(i + 1) ? '<i class="p"></i>' : '<i></i>')).join('');
/** 小さなサイコロ（記録・結果用） */
export const miniDice = (roll, cls = '') => `<span class="mdice ${cls}">${roll.map((v) => `<span class="md" data-v="${v}">${pips(v)}</span>`).join('')}</span>`;

/** 役の格（色分け用） */
export function tierOf(hand) {
  if (hand === 'pinzoro' || hand?.startsWith('arashi') || hand === 'shigoro') return 'gold';
  if (hand === 'hifumi' || hand === 'shonben') return 'red';
  if (hand === 'menashi' || hand === 'skip') return 'mute';
  return 'base';
}
export const handChip = (hand, label = handLabel(hand)) => `<span class="hc t-${tierOf(hand)}">${esc(label)}</span>`;
export const dot = (color) => `<i class="pdot" style="--c:${esc(color)}"></i>`;
export { handLabel };
