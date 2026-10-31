// 画面部品（エスケープ・アバター・サイコロ・トースト・シート・効果音）
import { HANDS, handLabel } from './rules.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function avatar(p, size = '') {
  const name = p?.name || '?';
  return `<span class="av ${size}" style="--c:${esc(p?.color || '#8E8E95')}" aria-hidden="true">${esc(Array.from(name)[0])}</span>`;
}

const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
export const pips = (v) => Array.from({ length: 9 }, (_, i) => (PIPS[v]?.includes(i + 1) ? '<i class="p"></i>' : '<i></i>')).join('');
export const die = (v, cls = '') => `<span class="die ${cls}" data-v="${v}">${pips(v)}</span>`;
export const miniDice = (roll, cls = '') => `<span class="mini-dice ${cls}">${roll.map((v) => die(v, 'die--xs')).join('')}</span>`;

/** 役の格（色分け用） */
export function tierOf(hand) {
  if (hand === 'pinzoro' || hand?.startsWith('arashi') || hand === 'shigoro') return 'gold';
  if (hand === 'hifumi') return 'red';
  if (hand === 'menashi' || hand === 'shonben' || hand === 'skip') return 'mute';
  return 'base';
}

export const handChip = (hand) => `<span class="hand-chip t-${tierOf(hand)}">${esc(handLabel(hand))}</span>`;
export { handLabel, HANDS };

export const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(d)}%`);

export function timeText(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ---------- トースト ----------
let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

// ---------- ボトムシート ----------
/** シートを開く。bind(el, close) でイベントを結び、閉じたら onClose を呼ぶ。 */
export function sheet(html, bind, onClose) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 260);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  bind?.(wrap.querySelector('.sheet'), close);
  wrap.querySelector('input:not([type=hidden])')?.focus();
  return close;
}

export function confirmSheet({ title, body = '', ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let accepted = false;
    sheet(`
      <h3 class="sheet-title">${esc(title)}</h3>
      ${body ? `<p class="sheet-text">${body}</p>` : ''}
      <div class="sheet-actions">
        <button class="btn ghost" data-close>キャンセル</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>
      </div>`, (el, close) => {
      el.querySelector('[data-ok]').addEventListener('click', () => { accepted = true; close(); });
    }, () => resolve(accepted));
  });
}

// ---------- ツールチップ（ホバー／タップで詳細） ----------
export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  let current = null;
  const show = (el) => {
    current = el;
    tip.innerHTML = el.dataset.tip;
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const y = r.top - tip.offsetHeight - 8;
    tip.style.transform = `translate(${x}px, ${y < 8 ? r.bottom + 8 : y}px)`;
  };
  const hide = () => { current = null; tip.classList.remove('show'); };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest('[data-tip]');
    if (el) show(el); else if (current) hide();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el !== current) show(el); else hide();
  });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, { passive: true });
}

// ---------- 効果音（どんぶりにサイコロが当たる音を合成） ----------
let ctx;
export const soundOn = () => localStorage.getItem('cc_sound') !== 'off';
export function setSound(on) { try { localStorage.setItem('cc_sound', on ? 'on' : 'off'); } catch { /* 保存できなくても続行 */ } }

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function clink(ac, at, gain) {
  const len = 0.05;
  const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200 + Math.random() * 2400;
  bp.Q.value = 6;
  const g = ac.createGain();
  g.gain.value = gain;
  noise.connect(bp).connect(g).connect(ac.destination);
  noise.start(at);
  const osc = ac.createOscillator();
  osc.frequency.value = 2600 + Math.random() * 1600;
  const og = ac.createGain();
  og.gain.setValueAtTime(gain * 0.35, at);
  og.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
  osc.connect(og).connect(ac.destination);
  osc.start(at);
  osc.stop(at + 0.13);
}

export function playRollSound(duration = 0.85) {
  if (!soundOn()) return;
  try {
    const ac = audio();
    let t = ac.currentTime + 0.02;
    const end = t + duration;
    let gain = 0.22;
    while (t < end) {
      clink(ac, t, gain);
      t += 0.05 + Math.random() * 0.13;
      gain *= 0.86;
    }
  } catch { /* 音が出せない環境では無視 */ }
}

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* 非対応 */ }
}
