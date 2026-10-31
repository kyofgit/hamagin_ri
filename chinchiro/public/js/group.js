// グループ画面（プレイ・記録・メンバー）。分析タブは stats.js。
import { api, app, topbar, socket, soundButton } from './app.js';
import { ICONS } from './icons.js';
import { esc, avatar, die, pips, miniDice, handChip, handLabel, tierOf, toast, sheet, confirmSheet, timeText, playRollSound, vibrate } from './ui.js';
import { MAX_ROLLS, MAX_RECORDS } from './rules.js';
import { roundsOf } from './analysis.js';
import { renderStats } from './stats.js';

const TABS = [
  { key: 'play', label: 'プレイ', icon: ICONS.play },
  { key: 'log', label: '記録', icon: ICONS.log },
  { key: 'stats', label: '分析', icon: ICONS.stats },
  { key: 'members', label: 'メンバー', icon: ICONS.members },
];
const ROLL_MIN_MS = 850;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

export async function mountGroup(root, gid, initialTab) {
  const S = {
    gid,
    tab: TABS.some((t) => t.key === initialTab) ? initialTab : 'play',
    group: null,
    records: [],
    people: {},
    queue: [],
    busy: false,
    rolling: null, // { started, timer }
    lastShown: null, // 直前に表示した出目 { uid, dice, hand, final }
    logLimit: 15,
    logMember: null,
    stats: { period: 'today', custom: {}, view: 'overview', member: app.me.uid, metric: 'hand:shigoro' },
    destroyed: false,
  };

  try {
    await load();
  } catch (e) {
    toast(e.message, 'error');
    location.replace('#/');
    return null;
  }

  async function load() {
    const d = await api(`/api/groups/${gid}`);
    S.group = d.group;
    S.records = d.records;
    S.people = d.people;
    mergePeople();
  }

  function mergePeople() {
    for (const m of S.group.members) S.people[m.uid] = { uid: m.uid, name: m.name, color: m.color };
  }

  const person = (uid) => S.people[uid] || { uid, name: '退会したメンバー', color: '#8E8E95' };
  const nameOf = (uid) => person(uid).name;
  const member = (uid) => S.group.members.find((m) => m.uid === uid);
  const isOwner = () => S.group.ownerId === app.me.uid;

  // ---------- 骨組み ----------
  root.innerHTML = `
    <div class="group-shell">
      <div data-slot="top"></div>
      <main class="page group-page" data-slot="tab"></main>
      <nav class="tabbar" aria-label="グループのメニュー"><div class="tabbar-in">
        ${TABS.map((t) => `<a class="tab" data-tab="${t.key}" href="#/g/${esc(gid)}/${t.key}">${t.icon}<span>${t.label}</span></a>`).join('')}
      </div></nav>
    </div>`;
  const slotTop = root.querySelector('[data-slot=top]');
  const slotTab = root.querySelector('[data-slot=tab]');

  function renderTop() {
    const online = S.group.members.filter((m) => m.online).length;
    slotTop.innerHTML = topbar({
      title: S.group.name,
      back: '#/',
      right: `<span class="online-pill" title="オンライン"><i></i>${online}</span>${soundButton()}`,
    });
  }

  function renderTabbar() {
    root.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === S.tab));
  }

  function render() {
    if (S.destroyed) return;
    renderTop();
    renderTabbar();
    if (S.tab === 'play') renderPlay();
    else if (S.tab === 'log') renderLog();
    else if (S.tab === 'stats') renderStats(slotTab, S, { person, nameOf, rerender: render });
    else renderMembers();
  }

  // ---------- リアルタイム ----------
  const sock = socket();
  let disconnected = false;
  const onConnect = async () => {
    sock.emit('watch', gid);
    if (disconnected) {
      disconnected = false;
      await load().catch(() => {});
      if (!S.busy) render();
    }
  };
  const onDisconnect = () => { disconnected = true; };
  const onUpdate = (msg) => { S.queue.push(msg); if (!S.busy) drain(); };
  const onPresence = ({ online }) => {
    const set = new Set(online);
    for (const m of S.group.members) m.online = set.has(m.uid);
    if (!S.busy) { renderTop(); if (S.tab === 'members') renderMembers(); }
  };
  const onRemoved = ({ groupId, deleted }) => {
    if (groupId !== gid) return;
    toast(deleted ? 'グループが削除されました' : 'グループから外れました');
    location.hash = '#/';
  };
  sock.on('connect', onConnect);
  sock.on('disconnect', onDisconnect);
  sock.on('update', onUpdate);
  sock.on('presence', onPresence);
  sock.on('removed', onRemoved);
  if (sock.connected) sock.emit('watch', gid);

  function mergeRecords(recs = []) {
    for (const r of recs) {
      const i = S.records.findIndex((x) => x.id === r.id);
      if (i >= 0) S.records[i] = r; else S.records.push(r);
    }
    S.records.sort((a, b) => a.id - b.id);
    if (S.records.length > MAX_RECORDS) S.records.splice(0, S.records.length - MAX_RECORDS);
  }

  async function drain() {
    S.busy = true;
    while (S.queue.length && !S.destroyed) {
      const { group, event } = S.queue.shift();
      mergeRecords(event?.records);
      const animate = event?.kind === 'roll' && S.tab === 'play' && document.visibilityState === 'visible' && slotTab.querySelector('.bowl');
      if (animate) await animateRoll(event);
      else if (event?.kind === 'roll') S.lastShown = { uid: event.uid, dice: event.dice, hand: event.hand, final: event.final, shonben: event.shonben };
      S.group = group;
      mergePeople();
      render();
      if (event?.roundEnd) {
        if (S.tab === 'play') showRoundResult(event.roundEnd, true);
        else toast(`第${event.roundEnd.round}周の結果が出ました`);
      }
    }
    S.busy = false;
  }

  // ---------- サイコロのアニメーション ----------
  function diceEls() { return [...slotTab.querySelectorAll('.bowl .die')]; }

  function scatter() {
    const bowl = slotTab.querySelector('.bowl');
    if (!bowl) return;
    const k = bowl.offsetWidth / 300;
    const base = [[-62, -26], [58, -34], [-4, 50]].sort(() => Math.random() - 0.5);
    diceEls().forEach((el, i) => {
      el.style.setProperty('--x', `${(base[i][0] + rand(-14, 14)) * k}px`);
      el.style.setProperty('--y', `${(base[i][1] + rand(-12, 12)) * k}px`);
      el.style.setProperty('--r', `${rand(-40, 40)}deg`);
    });
  }

  function startRolling() {
    if (S.rolling) return;
    const els = diceEls();
    if (!els.length) return;
    slotTab.querySelector('.result')?.classList.remove('show');
    slotTab.querySelector('.bowl')?.classList.remove('glow-gold', 'glow-red');
    els.forEach((el, i) => { el.classList.remove('landed', 'faded'); el.classList.add('rolling'); el.style.animationDuration = `${0.28 + i * 0.05}s`; });
    playRollSound();
    const tick = () => {
      els.forEach((el) => { const v = 1 + Math.floor(Math.random() * 6); el.dataset.v = v; el.innerHTML = pips(v); });
    };
    tick();
    scatter();
    S.rolling = { started: Date.now(), faces: setInterval(tick, 75), moves: setInterval(scatter, 230) };
  }

  function stopRolling(dice) {
    if (!S.rolling) return;
    clearInterval(S.rolling.faces);
    clearInterval(S.rolling.moves);
    S.rolling = null;
    const bowl = slotTab.querySelector('.bowl');
    const k = bowl ? bowl.offsetWidth / 300 : 1;
    S.dicePos = [];
    diceEls().forEach((el, i) => {
      el.classList.remove('rolling');
      S.dicePos.push(['--x', '--y', '--r'].map((v) => parseFloat(el.style.getPropertyValue(v)) / (v === '--r' ? 1 : k)));
      if (dice) { el.dataset.v = dice[i]; el.innerHTML = pips(dice[i]); }
      void el.offsetWidth;
      el.classList.add('landed');
    });
  }

  async function animateRoll(ev) {
    startRolling();
    const wait = ROLL_MIN_MS - (Date.now() - (S.rolling?.started || Date.now()));
    if (wait > 0) await sleep(wait);
    stopRolling(ev.dice);
    S.lastShown = { uid: ev.uid, dice: ev.dice, hand: ev.hand, final: ev.final, shonben: ev.shonben };
    const res = slotTab.querySelector('.result');
    if (res) {
      res.outerHTML = resultHtml(S.lastShown, ev.rollNo);
      requestAnimationFrame(() => slotTab.querySelector('.result')?.classList.add('show', 'pop'));
    }
    const tier = ev.final ? tierOf(ev.hand) : 'mute';
    if (tier === 'gold') slotTab.querySelector('.bowl')?.classList.add('glow-gold');
    if (tier === 'red' || ev.shonben) slotTab.querySelector('.bowl')?.classList.add('glow-red');
    if (ev.final && ev.uid === app.me.uid) vibrate(tier === 'gold' ? [30, 60, 30] : 25);
    await sleep(ev.final ? 1300 : 650);
  }

  function resultHtml(shown, rollNo) {
    if (!shown) return '<div class="result idle"><div class="result-hand">サイコロを振ろう</div><div class="result-sub">役が出るまで最大3回</div></div>';
    if (shown.final) {
      const sub = shown.shonben ? 'どんぶりの外へ…' : `${esc(nameOf(shown.uid))}`;
      return `<div class="result t-${tierOf(shown.hand)}"><div class="result-hand">${esc(handLabel(shown.hand))}</div><div class="result-sub">${sub}</div></div>`;
    }
    const left = MAX_ROLLS - (rollNo || 0);
    return `<div class="result t-mute"><div class="result-hand">目なし</div><div class="result-sub">もう一度 · あと${left}回</div></div>`;
  }

  // ---------- プレイ ----------
  function renderPlay() {
    const g = S.group.game;
    const turn = g.turn;
    const myTurn = turn?.uid === app.me.uid;
    const lineup = g.lineup;
    const doneCount = lineup.filter((u) => u in g.results).length;

    // どんぶりに表示する出目：進行中のターンがあればその最新、なければ直前の結果
    let shown = S.lastShown;
    let rollNo = 0;
    if (turn && turn.rolls.length) {
      shown = { uid: turn.uid, dice: turn.rolls.at(-1), hand: null, final: false };
      rollNo = turn.rolls.length;
    } else if (!shown) {
      const last = [...S.records].reverse().find((r) => r.h !== 'skip');
      if (last) shown = { uid: last.u, dice: last.rolls.at(-1), hand: last.h, final: true, shonben: !!last.sb };
    }
    const dice = shown?.dice || [4, 5, 6];
    const triesUsed = turn ? turn.rolls.length : 0;

    slotTab.innerHTML = `
      <section class="play">
        <div class="round-head">
          <div class="round-no"><span class="eyebrow">Round</span><b>${g.round}</b></div>
          <div class="round-progress" aria-label="${doneCount}/${lineup.length}人">
            ${lineup.map((u) => `<i class="${u in g.results ? 'done' : u === turn?.uid ? 'now' : ''}"></i>`).join('')}
          </div>
          <div class="round-count">${doneCount}<span>/${lineup.length}</span></div>
        </div>

        ${turn ? `
        <div class="turn ${myTurn ? 'mine' : ''}">
          ${avatar(person(turn.uid), 'lg')}
          <div class="turn-text">
            <div class="turn-label">${myTurn ? 'あなたの番です' : 'いまの番'}</div>
            <div class="turn-name">${esc(nameOf(turn.uid))}</div>
          </div>
          <div class="tries" aria-label="${triesUsed}投目まで終了">
            ${Array.from({ length: MAX_ROLLS }, (_, i) => `<i class="${i < triesUsed ? 'used' : ''}"></i>`).join('')}
            <span>${triesUsed ? `${triesUsed}/${MAX_ROLLS}` : '3投まで'}</span>
          </div>
        </div>` : `
        <div class="turn idle-turn">
          <div class="turn-text"><div class="turn-label">お休み中</div><div class="turn-name">全員が休憩中です</div></div>
        </div>`}

        <div class="bowl-wrap">
          <div class="bowl">
            <div class="bowl-inner"></div>
            ${dice.map((v) => die(v, `die--lg ${shown ? '' : 'faded'}`)).join('')}
          </div>
        </div>

        ${resultHtml(shown && (shown.final || rollNo) ? shown : null, rollNo).replace('class="result', 'class="result show')}

        <div class="actions">
          ${turn ? (myTurn ? `
            <button class="btn primary xl block" data-act="roll">サイコロを振る</button>
            <button class="btn ghost sm" data-act="skip">今回はスキップ</button>
          ` : `
            <p class="wait-text">${esc(nameOf(turn.uid))}さんが振るのを待っています</p>
            <div class="btn-row">
              <button class="btn secondary" data-act="proxy">代わりに振る</button>
              <button class="btn secondary" data-act="skip">スキップ</button>
            </div>
          `) : `<a class="btn secondary block" href="#/g/${esc(gid)}/members">メンバーの休憩を解除する</a>`}
        </div>

        <div class="card board">
          <div class="board-head">
            <h2 class="section-title">この周</h2>
            ${S.group.lastRound ? '<button class="link" data-act="last-round">前の周の結果</button>' : ''}
          </div>
          <ul class="board-list">
            ${lineup.map((uid) => boardRow(uid, g)).join('') || '<li class="board-empty">参加できるメンバーがいません</li>'}
          </ul>
        </div>
      </section>`;

    scatterStatic();
    slotTab.querySelector('[data-act=roll]')?.addEventListener('click', () => doRoll(false));
    slotTab.querySelector('[data-act=proxy]')?.addEventListener('click', () => doRoll(true));
    slotTab.querySelector('[data-act=skip]')?.addEventListener('click', doSkip);
    slotTab.querySelector('[data-act=last-round]')?.addEventListener('click', () => showRoundResult(S.group.lastRound));
  }

  // 静止時のサイコロ配置（再描画しても同じ並びに見えるよう固定値を少し崩す）
  function scatterStatic() {
    const bowl = slotTab.querySelector('.bowl');
    const k = bowl.offsetWidth / 300;
    const pos = S.dicePos || [[-62, -24, -14], [58, -32, 18], [-2, 50, 6]];
    diceEls().forEach((el, i) => {
      el.style.setProperty('--x', `${pos[i][0] * k}px`);
      el.style.setProperty('--y', `${pos[i][1] * k}px`);
      el.style.setProperty('--r', `${pos[i][2]}deg`);
    });
  }

  function boardRow(uid, g) {
    const m = member(uid);
    let status;
    if (uid in g.results) {
      const rec = S.records.find((r) => r.id === g.results[uid]);
      status = rec ? (rec.h === 'skip' ? '<span class="status">スキップ</span>' : `${handChip(rec.h)}${miniDice(rec.rolls.at(-1))}`) : '';
    } else if (g.turn?.uid === uid) status = '<span class="status now"><i></i>振っています</span>';
    else if (!m) status = '<span class="status">退会</span>';
    else if (m.away) status = '<span class="status">休憩中</span>';
    else status = '<span class="status">待ち</span>';
    return `<li class="board-row ${g.turn?.uid === uid ? 'current' : ''}">
      ${avatar(person(uid), 'sm')}
      <span class="board-name">${esc(nameOf(uid))}${uid === app.me.uid ? '<em>あなた</em>' : ''}</span>
      <span class="board-status">${status}</span>
    </li>`;
  }

  async function doRoll(proxy) {
    const turn = S.group.game.turn;
    if (!turn || S.rolling || S.busy) return;
    if (proxy && !(await confirmSheet({ title: `${nameOf(turn.uid)}さんの代わりに振りますか？`, body: '出目は本人の記録として残ります。', ok: '代わりに振る' }))) return;
    const key = S.group.game.key;
    slotTab.querySelectorAll('.actions button').forEach((b) => { b.disabled = true; });
    startRolling();
    try {
      await api(`/api/groups/${gid}/roll`, { key });
    } catch (e) {
      stopRolling(null);
      toast(e.message, 'error');
      await load().catch(() => {});
      render();
    }
  }

  async function doSkip() {
    const turn = S.group.game.turn;
    if (!turn) return;
    const self = turn.uid === app.me.uid;
    const ok = await confirmSheet({
      title: self ? '今回の番をスキップしますか？' : `${nameOf(turn.uid)}さんを今回だけスキップしますか？`,
      body: 'この周だけ飛ばします。しばらく抜けるときは「メンバー」タブで休憩にできます。',
      ok: 'スキップ',
    });
    if (!ok) return;
    try { await api(`/api/groups/${gid}/skip`, { key: S.group.game.key }); } catch (e) { toast(e.message, 'error'); }
  }

  function showRoundResult(rd, fresh = false) {
    if (!rd) return;
    const played = rd.entries.filter((e) => e.hand !== 'skip');
    sheet(`
      <div class="rr">
        <p class="eyebrow">Round ${rd.round} Result</p>
        <h3 class="sheet-title">第${rd.round}周の結果</h3>
        <ol class="rr-list">
          ${rd.entries.map((e) => `
            <li class="rr-row ${e.top ? 'top' : ''} ${e.bottom ? 'bottom' : ''} ${e.hand === 'skip' ? 'skip' : ''}">
              <span class="rr-rank">${e.rank ?? '–'}</span>
              ${avatar(person(e.uid), 'md')}
              <span class="rr-name">${esc(nameOf(e.uid))}${e.top ? '<span class="badge gold">最強</span>' : ''}${e.bottom ? '<span class="badge red">最弱</span>' : ''}</span>
              <span class="rr-hand">${e.hand === 'skip' ? '<span class="status">スキップ</span>' : `${handChip(e.hand)}${e.dice ? miniDice(e.dice) : ''}`}</span>
            </li>`).join('')}
        </ol>
        ${played.length >= 2 && !played.some((e) => e.top) ? '<p class="sheet-text center">全員同じ強さ。引き分けです。</p>' : ''}
        <button class="btn primary block lg" data-close>${fresh ? '次の周へ' : '閉じる'}</button>
      </div>`);
  }

  // ---------- 記録 ----------
  function renderLog() {
    const rounds = roundsOf(S.records);
    const turns = S.records.filter((r) => r.h !== 'skip').length;
    const ids = [...new Set([...S.group.members.map((m) => m.uid), ...S.records.map((r) => r.u)])];
    const filter = S.logMember;
    const recRow = (r, withRound = false) => `
      <li class="log-row">
        ${withRound ? `<span class="log-rno">第${r.r}周<small>${timeText(r.t)}</small></span>` : avatar(person(r.u), 'sm')}
        <div class="log-main">
          ${withRound ? '' : `<div class="log-name">${esc(nameOf(r.u))}${r.top ? '<span class="badge gold">最強</span>' : ''}${r.bottom ? '<span class="badge red">最弱</span>' : ''}</div>`}
          ${withRound && (r.top || r.bottom) ? `<div>${r.top ? '<span class="badge gold">最強</span>' : ''}${r.bottom ? '<span class="badge red">最弱</span>' : ''}</div>` : ''}
          ${r.by ? `<div class="log-note">${esc(nameOf(r.by))}さんが${r.h === 'skip' ? 'スキップ' : '代理で振りました'}</div>` : ''}
        </div>
        <div class="log-result">
          ${r.h === 'skip' ? '<span class="status">スキップ</span>' : `${handChip(r.h)}<div class="log-rolls">${r.rolls.map((roll, i) => miniDice(roll, i < r.rolls.length - 1 ? 'past' : '')).join('')}</div>`}
        </div>
      </li>`;

    let body;
    if (filter) {
      const mine = S.records.filter((r) => r.u === filter).reverse();
      const shown = mine.slice(0, S.logLimit * 3);
      body = shown.length
        ? `<section class="card log-round"><ul class="log-flat">${shown.map((r) => recRow(r, true)).join('')}</ul></section>
           ${mine.length > shown.length ? '<button class="btn secondary block" data-act="more">もっと見る</button>' : ''}`
        : '<div class="empty card"><p class="empty-title">まだ記録がありません</p></div>';
    } else {
      const shown = rounds.slice(0, S.logLimit);
      body = shown.length ? shown.map((rd) => {
        const inProgress = rd.round === S.group.game.round;
        const recs = [...rd.records].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.id - b.id);
        return `<section class="card log-round">
          <header class="log-head"><span class="log-round-no">第${rd.round}周</span>${inProgress ? '<span class="badge">進行中</span>' : ''}<span class="log-time">${timeText(rd.at)}</span></header>
          <ul>${recs.map((r) => recRow(r)).join('')}</ul>
        </section>`;
      }).join('') + (rounds.length > S.logLimit ? '<button class="btn secondary block" data-act="more">もっと見る</button>' : '')
        : '<div class="empty card"><p class="empty-title">まだ記録がありません</p><p class="empty-text">「プレイ」からサイコロを振ると、ここに残ります。</p></div>';
    }

    slotTab.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">記録</h1>
        <p class="page-sub">${rounds.length}周 · ${turns}ターン（最新${MAX_RECORDS}件まで保存）</p>
      </div>
      <div class="chips people" aria-label="メンバーで絞り込み">
        <button class="chip ${filter ? '' : 'on'}" data-log-member="">全員</button>
        ${ids.map((id) => `<button class="chip person ${filter === id ? 'on' : ''}" data-log-member="${esc(id)}">${avatar(person(id), 'xs')}${esc(nameOf(id))}</button>`).join('')}
      </div>
      ${body}`;
    slotTab.querySelectorAll('[data-log-member]').forEach((b) => b.addEventListener('click', () => {
      S.logMember = b.dataset.logMember || null;
      S.logLimit = 15;
      renderLog();
    }));
    slotTab.querySelector('[data-act=more]')?.addEventListener('click', () => { S.logLimit += 20; renderLog(); });
  }

  // ---------- メンバー ----------
  function renderMembers() {
    const owner = isOwner();
    const link = `${location.origin}${location.pathname}#/join/${S.group.code}`;
    slotTab.innerHTML = `
      <div class="page-head"><h1 class="page-title">メンバー</h1></div>
      <section class="card invite">
        <div class="invite-label">招待コード</div>
        <div class="invite-code">${esc(S.group.code)}</div>
        <div class="btn-row">
          <button class="btn secondary sm" data-act="copy">${ICONS.copy}コードをコピー</button>
          <button class="btn secondary sm" data-act="share">${ICONS.share}リンクを送る</button>
        </div>
      </section>

      <section class="card">
        <div class="board-head pad-x">
          <h2 class="section-title">順番</h2>
          <button class="link" data-act="shuffle">${ICONS.shuffle}シャッフル</button>
        </div>
        <ul class="member-list">
          ${S.group.members.map((m, i) => `
          <li class="member-row ${m.away ? 'away' : ''}">
            <span class="member-no">${i + 1}</span>
            <span class="av-wrap">${avatar(m, 'md')}<i class="dot ${m.online ? 'on' : ''}" title="${m.online ? 'オンライン' : 'オフライン'}"></i></span>
            <div class="member-main">
              <div class="member-name">${esc(m.name)}${m.uid === app.me.uid ? '<em>あなた</em>' : ''}${m.uid === S.group.ownerId ? '<span class="badge">作成者</span>' : ''}</div>
              <div class="member-sub">${m.away ? '休憩中 · 順番を飛ばします' : m.online ? 'オンライン' : 'オフライン'}</div>
            </div>
            <label class="switch sm" title="休憩"><input type="checkbox" data-away="${esc(m.uid)}" ${m.away ? 'checked' : ''} aria-label="${esc(m.name)}を休憩にする"><span></span></label>
            <div class="order-btns">
              <button class="icon-btn sm" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="上へ">${ICONS.up}</button>
              <button class="icon-btn sm" data-move="${i}:1" ${i === S.group.members.length - 1 ? 'disabled' : ''} aria-label="下へ">${ICONS.down}</button>
            </div>
            ${owner && m.uid !== app.me.uid ? `<button class="icon-btn sm" data-kick="${esc(m.uid)}" aria-label="${esc(m.name)}を外す">${ICONS.x}</button>` : ''}
          </li>`).join('')}
        </ul>
        <p class="hint pad-x">スイッチをオンにすると<b>休憩中</b>になり、順番が来ても自動で飛ばします。1回だけ飛ばすときはプレイ画面の「スキップ」を使います。並び替えは、まだ誰も振っていない周ならすぐ、そうでなければ次の周から反映されます。</p>
      </section>

      <section class="card pad">
        <div class="row-between">
          <div><div class="label-strong">ルール</div><div class="member-sub">ションベン ${S.group.settings.shonben ? `あり（${Math.round(S.group.settings.shonbenRate * 100)}%）` : 'なし'}</div></div>
          ${owner ? `<button class="btn secondary sm" data-act="settings">${ICONS.gear}設定</button>` : ''}
        </div>
      </section>

      <div class="stack-sm">
        <button class="btn ghost block danger-text" data-act="leave">グループから抜ける</button>
        ${owner ? '<button class="btn ghost block danger-text" data-act="delete">グループを削除</button>' : ''}
      </div>`;

    const q = (s) => slotTab.querySelector(s);
    q('[data-act=copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(S.group.code); toast('コードをコピーしました'); } catch { toast(S.group.code); }
    });
    q('[data-act=share]').addEventListener('click', async () => {
      const text = `チンチロのグループ「${S.group.name}」に参加しよう（招待コード: ${S.group.code}）`;
      if (navigator.share) { try { await navigator.share({ title: 'チンチロ', text, url: link }); } catch { /* キャンセル */ } return; }
      try { await navigator.clipboard.writeText(`${text}\n${link}`); toast('招待リンクをコピーしました'); } catch { toast(link); }
    });
    q('[data-act=shuffle]').addEventListener('click', () => post('order', { shuffle: true }, '順番をシャッフルしました'));
    slotTab.querySelectorAll('[data-away]').forEach((el) => el.addEventListener('change', () => post('away', { uid: el.dataset.away, away: el.checked })));
    slotTab.querySelectorAll('[data-move]').forEach((el) => el.addEventListener('click', () => {
      const [i, d] = el.dataset.move.split(':').map(Number);
      const order = S.group.members.map((m) => m.uid);
      [order[i], order[i + d]] = [order[i + d], order[i]];
      post('order', { order });
    }));
    slotTab.querySelectorAll('[data-kick]').forEach((el) => el.addEventListener('click', async () => {
      const uid = el.dataset.kick;
      if (await confirmSheet({ title: `${nameOf(uid)}さんをグループから外しますか？`, body: 'これまでの記録は残ります。', ok: '外す', danger: true })) post('kick', { uid });
    }));
    q('[data-act=settings]')?.addEventListener('click', settingsSheet);
    q('[data-act=leave]').addEventListener('click', async () => {
      if (!(await confirmSheet({ title: 'グループから抜けますか？', body: 'もう一度参加するには招待コードが必要です。', ok: '抜ける', danger: true }))) return;
      try { await api(`/api/groups/${gid}/leave`, {}); location.hash = '#/'; } catch (e) { toast(e.message, 'error'); }
    });
    q('[data-act=delete]')?.addEventListener('click', async () => {
      if (!(await confirmSheet({ title: 'グループを削除しますか？', body: `「${esc(S.group.name)}」と<b>すべての記録</b>が消えます。元に戻せません。`, ok: '削除する', danger: true }))) return;
      try { await api(`/api/groups/${gid}`, null, 'DELETE'); location.hash = '#/'; } catch (e) { toast(e.message, 'error'); }
    });
  }

  async function post(action, body, msg) {
    try { await api(`/api/groups/${gid}/${action}`, body); if (msg) toast(msg); } catch (e) { toast(e.message, 'error'); render(); }
  }

  function settingsSheet() {
    const s = S.group.settings;
    sheet(`
      <h3 class="sheet-title">グループ設定</h3>
      <form class="sheet-form">
        <label class="field"><span>グループ名</span><input name="name" maxlength="20" value="${esc(S.group.name)}" required></label>
        <div class="row-between">
          <div><div class="label-strong">ションベンあり</div><div class="member-sub">サイコロがどんぶりから出て即負け</div></div>
          <label class="switch"><input type="checkbox" name="shonben" ${s.shonben ? 'checked' : ''}><span></span></label>
        </div>
        <label class="field"><span>ションベンになる確率（1投ごと）</span>
          <select name="rate">${[0.02, 0.03, 0.05, 0.08, 0.1].map((r) => `<option value="${r}" ${Math.abs(r - s.shonbenRate) < 1e-9 ? 'selected' : ''}>${Math.round(r * 100)}%</option>`).join('')}</select>
        </label>
        <div class="sheet-actions">
          <button type="button" class="btn ghost" data-close>キャンセル</button>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>`, (el, close) => {
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await api(`/api/groups/${gid}`, { name: f.name.value, settings: { shonben: f.shonben.checked, shonbenRate: Number(f.rate.value) } }, 'PATCH');
          toast('保存しました');
          close();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  render();

  return {
    groupId: gid,
    setTab(tab) {
      if (!TABS.some((t) => t.key === tab) || tab === S.tab) return;
      if (S.rolling) stopRolling(null);
      S.tab = tab;
      window.scrollTo(0, 0);
      if (!S.busy) render(); else renderTabbar();
    },
    destroy() {
      S.destroyed = true;
      if (S.rolling) stopRolling(null);
      sock.emit('unwatch');
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.off('update', onUpdate);
      sock.off('presence', onPresence);
      sock.off('removed', onRemoved);
    },
  };
}
