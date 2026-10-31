// ルーター・ログイン・ホーム・プロフィール
import { esc, avatar, toast, sheet, installTooltips, soundOn, setSound, die } from './ui.js';
import { mountGroup } from './group.js';
import { ICONS } from './icons.js';

export { ICONS };

export async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '通信に失敗しました'), { status: res.status });
  return data;
}

const root = document.getElementById('app');
export const app = { me: null, colors: [], socket: null, view: null };

// ---------- テーマ ----------
const THEME_KEY = 'cc_theme';
function applyTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* 無視 */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme();

// ---------- 共通の上部バー ----------
export function topbar({ title = '', back = null, right = '' } = {}) {
  return `<header class="topbar">
    <div class="topbar-in">
      ${back ? `<a class="icon-btn" href="${back}" aria-label="戻る">${ICONS.back}</a>` : '<a class="brand" href="#/">chinchiro<span>.</span></a>'}
      <div class="topbar-title">${esc(title)}</div>
      <div class="topbar-right">${right}</div>
    </div>
  </header>`;
}


export function soundButton() {
  return `<button class="icon-btn" data-act="sound" aria-label="効果音の切り替え">${soundOn() ? ICONS.soundOn : ICONS.soundOff}</button>`;
}

// ---------- ソケット ----------
export function socket() {
  if (!app.socket) app.socket = window.io();
  return app.socket;
}

// ---------- ルーティング ----------
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return parts;
}

async function loadMe() {
  try {
    const data = await api('/api/me');
    app.me = data.user;
    app.colors = data.colors;
    return data;
  } catch (e) {
    if (e.status === 401) { app.me = null; return null; }
    throw e;
  }
}

async function route() {
  app.view?.destroy?.();
  app.view = null;
  window.scrollTo(0, 0);
  const parts = parseRoute();
  const data = await loadMe().catch(() => null);
  if (!app.me) {
    if (parts[0] === 'join' && parts[1]) sessionStorage.setItem('cc_join', parts[1]);
    return renderLogin();
  }
  const pendingJoin = sessionStorage.getItem('cc_join');
  if (pendingJoin) {
    sessionStorage.removeItem('cc_join');
    return joinByCode(pendingJoin);
  }
  if (parts[0] === 'join' && parts[1]) return joinByCode(parts[1]);
  if (parts[0] === 'g' && parts[1]) {
    app.view = await mountGroup(root, parts[1], parts[2] || 'play');
    return;
  }
  if (parts[0] === 'me') return renderProfile();
  return renderHome(data);
}

window.addEventListener('hashchange', () => {
  // グループ内のタブ切り替えは画面を作り直さない
  const parts = parseRoute();
  if (app.view?.groupId && parts[0] === 'g' && parts[1] === app.view.groupId) { app.view.setTab(parts[2] || 'play'); return; }
  route();
});

async function joinByCode(code) {
  try {
    const { id } = await api('/api/groups/join', { code });
    location.replace(`#/g/${id}/play`);
  } catch (e) {
    toast(e.message, 'error');
    location.replace('#/');
  }
}

// ---------- ログイン ----------
function renderLogin(mode = 'login') {
  const isReg = mode === 'register';
  root.innerHTML = `
  <main class="auth">
    <div class="auth-hero">
      <div class="auth-dice">${die(4, 'die--md tilt-1')}${die(5, 'die--md tilt-2')}${die(6, 'die--md tilt-3')}</div>
      <h1 class="auth-logo">チンチロ</h1>
      <p class="auth-tag">サイコロ3つ、どんぶりひとつ。<br>みんなの出目を、ぜんぶ記録。</p>
    </div>
    <form class="card auth-card" novalidate>
      <div class="seg" role="tablist">
        <button type="button" class="seg-item ${isReg ? '' : 'on'}" data-mode="login">ログイン</button>
        <button type="button" class="seg-item ${isReg ? 'on' : ''}" data-mode="register">新規登録</button>
      </div>
      <label class="field"><span>ログインID</span>
        <input name="loginId" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="半角英数字" required></label>
      ${isReg ? `<label class="field"><span>表示名</span><input name="name" maxlength="12" placeholder="みんなに見える名前" required></label>` : ''}
      <label class="field"><span>パスワード</span>
        <input name="password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" placeholder="${isReg ? '4文字以上' : ''}" required></label>
      <button class="btn primary block lg" type="submit">${isReg ? 'はじめる' : 'ログイン'}</button>
    </form>
    <p class="auth-foot">グループを作って、招待コードを送るだけ。</p>
  </main>`;
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderLogin(b.dataset.mode)));
  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api(isReg ? '/api/auth/register' : '/api/auth/login', body);
      app.socket?.disconnect();
      app.socket = null;
      await route();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

// ---------- ホーム ----------
function renderHome(data) {
  const groups = data?.groups || [];
  root.innerHTML = `
  ${topbar({ right: `<a href="#/me" class="me-link" aria-label="プロフィール">${avatar(app.me, 'sm')}</a>` })}
  <main class="page">
    <div class="page-head">
      <p class="eyebrow">こんばんは、${esc(app.me.name)}さん</p>
      <h1 class="page-title">グループ</h1>
    </div>
    <div class="home-actions">
      <button class="btn primary" data-act="create">${ICONS.plus}グループを作る</button>
      <button class="btn secondary" data-act="join">${ICONS.enter}コードで参加</button>
    </div>
    ${groups.length ? `<ul class="group-list">${groups.map((g) => `
      <li><a class="group-item card" href="#/g/${esc(g.id)}/play">
        <div class="group-main">
          <div class="group-name">${esc(g.name)}</div>
          <div class="group-meta">${g.members.length}人 · ${g.records}ターン${g.updatedAt ? ` · ${relTime(g.updatedAt)}` : ''}</div>
        </div>
        <div class="av-stack">${g.members.slice(0, 4).map((m) => avatar(m, 'sm')).join('')}${g.members.length > 4 ? `<span class="av sm more">+${g.members.length - 4}</span>` : ''}</div>
        <span class="chev">${ICONS.chevron}</span>
      </a></li>`).join('')}</ul>`
    : `<div class="empty card">
        <div class="empty-dice">${die(1, 'die--sm')}</div>
        <p class="empty-title">まだグループがありません</p>
        <p class="empty-text">グループを作って招待コードを共有するか、<br>もらったコードで参加しましょう。</p>
      </div>`}
  </main>`;
  root.querySelector('[data-act=create]').addEventListener('click', createGroupSheet);
  root.querySelector('[data-act=join]').addEventListener('click', joinSheet);
}

function relTime(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}日前` : new Date(ts).toLocaleDateString('ja-JP');
}

function formSheet({ title, field, placeholder, submit, maxlength, onSubmit, transform }) {
  sheet(`
    <h3 class="sheet-title">${esc(title)}</h3>
    <form class="sheet-form">
      <label class="field"><span>${esc(field)}</span><input name="v" maxlength="${maxlength}" placeholder="${esc(placeholder)}" autocomplete="off" required></label>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-close>キャンセル</button>
        <button class="btn primary" type="submit">${esc(submit)}</button>
      </div>
    </form>`, (el, close) => {
    const input = el.querySelector('input');
    if (transform) input.addEventListener('input', () => { input.value = transform(input.value); });
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await onSubmit(input.value.trim()); close(); } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function createGroupSheet() {
  formSheet({
    title: 'グループを作る', field: 'グループ名', placeholder: '例）金曜の飲み会', submit: '作成', maxlength: 20,
    onSubmit: async (name) => { const { id } = await api('/api/groups', { name }); location.hash = `#/g/${id}/members`; },
  });
}

function joinSheet() {
  formSheet({
    title: '招待コードで参加', field: '招待コード（6文字）', placeholder: 'ABC234', submit: '参加', maxlength: 6,
    transform: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    onSubmit: async (code) => { const { id } = await api('/api/groups/join', { code }); location.hash = `#/g/${id}/play`; },
  });
}

// ---------- プロフィール ----------
function renderProfile() {
  let theme = 'system';
  try { theme = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* 無視 */ }
  root.innerHTML = `
  ${topbar({ title: 'プロフィール', back: '#/' })}
  <main class="page">
    <section class="card profile-card">
      ${avatar(app.me, 'xl')}
      <div class="profile-name">${esc(app.me.name)}</div>
      <div class="profile-id">@${esc(app.me.loginId)}</div>
    </section>
    <section class="card pad">
      <form class="stack" data-form="name">
        <label class="field"><span>表示名</span><input name="name" maxlength="12" value="${esc(app.me.name)}" required></label>
        <div class="field"><span>アイコンの色</span>
          <div class="swatches">${app.colors.map((c) => `<button type="button" class="swatch ${c === app.me.color ? 'on' : ''}" style="--c:${c}" data-color="${c}" aria-label="${c}"></button>`).join('')}</div>
        </div>
        <button class="btn primary" type="submit">保存</button>
      </form>
    </section>
    <section class="card pad">
      <div class="field"><span>表示テーマ</span>
        <div class="seg">${[['system', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([k, l]) => `<button type="button" class="seg-item ${theme === k ? 'on' : ''}" data-theme="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="row-between mt">
        <span class="label-strong">効果音</span>
        <label class="switch"><input type="checkbox" data-sound ${soundOn() ? 'checked' : ''}><span></span></label>
      </div>
    </section>
    <section class="card pad">
      <form class="stack" data-form="password">
        <label class="field"><span>現在のパスワード</span><input name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>新しいパスワード</span><input name="password" type="password" autocomplete="new-password" required></label>
        <button class="btn secondary" type="submit">パスワードを変更</button>
      </form>
    </section>
    <button class="btn ghost block danger-text" data-act="logout">ログアウト</button>
  </main>`;
  let color = app.me.color;
  root.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
    color = b.dataset.color;
    root.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  root.querySelector('[data-form=name]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me', { name: e.target.name.value, color }, 'PATCH');
      toast('保存しました');
      await loadMe();
      renderProfile();
    } catch (err) { toast(err.message, 'error'); }
  });
  root.querySelector('[data-form=password]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me', Object.fromEntries(new FormData(e.target)), 'PATCH');
      e.target.reset();
      toast('パスワードを変更しました');
    } catch (err) { toast(err.message, 'error'); }
  });
  root.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => {
    try {
      if (b.dataset.theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, b.dataset.theme);
    } catch { /* 無視 */ }
    applyTheme();
    root.querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  root.querySelector('[data-sound]').addEventListener('change', (e) => setSound(e.target.checked));
  root.querySelector('[data-act=logout]').addEventListener('click', async () => {
    await api('/api/auth/logout', {});
    app.socket?.disconnect();
    app.socket = null;
    location.hash = '#/';
    route();
  });
}

// 効果音ボタン（どの画面でも共通）
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act=sound]');
  if (!b) return;
  setSound(!soundOn());
  b.innerHTML = soundOn() ? ICONS.soundOn : ICONS.soundOff;
  toast(soundOn() ? '効果音オン' : '効果音オフ');
});

installTooltips();
route();
