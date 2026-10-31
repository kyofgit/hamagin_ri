// 分析タブ
import { app } from './app.js';
import { esc, avatar, handChip, tierOf, pct } from './ui.js';
import { CATEGORIES, GROUPS, theoreticalHandProbs, theoreticalFor } from './rules.js';
import {
  PERIODS, DAY_START_HOUR, MIN_SAMPLE, filterRecords, periodRange, analyze, buildMetrics, rankBy,
  headToHead, insights, faceBias, zScore, biasWord, rate,
} from './analysis.js';

const VIEWS = [
  { key: 'overview', label: '概要' },
  { key: 'person', label: '個人' },
  { key: 'ranking', label: 'ランキング' },
  { key: 'h2h', label: '対戦' },
];
const QUICK_METRICS = ['hand:shigoro', 'hand:arashi', 'hand:pinzoro', 'hand:hifumi', 'hand:menashi', 'top', 'bottom', 'again:hifumi'];
const QUICK_LABEL = { top: '最強率', bottom: '最弱率', 'again:hifumi': 'ヒフミ連続' };

export function renderStats(el, S, h) {
  const st = S.stats;
  const settings = S.group.settings;
  const recs = filterRecords(S.records, st.period, Date.now(), st.custom);
  const res = analyze(recs);
  const hasShonben = recs.some((r) => r.h === 'shonben');
  const ctx = { S, h, settings, res, recs, hasShonben, sr: settings.shonben ? settings.shonbenRate : 0 };

  el.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">分析</h1>
      <p class="page-sub">${esc(periodText(st))} · ${res.total.n}ターン</p>
    </div>
    <div class="chips" role="tablist" aria-label="期間">
      ${PERIODS.map((p) => `<button class="chip ${st.period === p.key ? 'on' : ''}" data-period="${p.key}">${p.label}</button>`).join('')}
    </div>
    ${st.period === 'custom' ? `
      <div class="date-range card pad-sm">
        <label><span>開始</span><input type="date" data-date="from" value="${esc(st.custom.from || '')}"></label>
        <span class="date-sep">〜</span>
        <label><span>終了</span><input type="date" data-date="to" value="${esc(st.custom.to || '')}"></label>
      </div>` : ''}
    <div class="seg seg-wide" role="tablist" aria-label="分析の種類">
      ${VIEWS.map((v) => `<button class="seg-item ${st.view === v.key ? 'on' : ''}" data-view="${v.key}">${v.label}</button>`).join('')}
    </div>
    <div class="stats-body">
      ${res.total.n === 0 && st.view !== 'h2h' ? emptyHtml() : VIEW_RENDER[st.view](ctx)}
    </div>`;

  el.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { st.period = b.dataset.period; h.rerender(); }));
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { st.view = b.dataset.view; h.rerender(); }));
  el.querySelectorAll('[data-date]').forEach((inp) => inp.addEventListener('change', () => { st.custom[inp.dataset.date] = inp.value; h.rerender(); }));
  el.querySelectorAll('[data-member]').forEach((b) => b.addEventListener('click', () => { st.member = b.dataset.member; h.rerender(); }));
  el.querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => { st.metric = b.dataset.metric; h.rerender(); }));
  el.querySelector('[data-metric-select]')?.addEventListener('change', (e) => { st.metric = e.target.value; h.rerender(); });
  el.querySelector('.chips .chip.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function periodText(st) {
  const fmt = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  if (st.period === 'all') return '全期間（保存されている最新1000件）';
  if (st.period === 'last100') return 'グループ全体の直近100ターン';
  if (st.period === 'last10rounds') return '直近10周';
  const r = periodRange(st.period, Date.now(), st.custom);
  if (!r) return '';
  const from = Number.isFinite(r[0]) ? `${fmt(r[0])} ${DAY_START_HOUR}:00` : 'はじめ';
  const to = Number.isFinite(r[1]) ? `${fmt(r[1])} ${DAY_START_HOUR}:00` : '現在';
  return `${from} 〜 ${to}`;
}

const emptyHtml = () => `<div class="empty card"><p class="empty-title">この期間の記録はありません</p><p class="empty-text">期間を変えてみてください。1日の区切りは朝${DAY_START_HOUR}時です。</p></div>`;

const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;

// ---------- 役の出現率チャート ----------
function handBars(stats, ctx, compare) {
  const theo = theoreticalHandProbs(ctx.sr);
  const cats = CATEGORIES.filter((c) => !c.optional || ctx.settings.shonben || ctx.hasShonben);
  const rows = cats.map((c) => {
    const obs = rate(stats.counts[c.key], stats.n) ?? 0;
    const th = c.hands.reduce((s, x) => s + theo[x], 0);
    const cmp = compare ? rate(compare.counts[c.key], compare.n) : null;
    return { c, obs, th, cmp, k: stats.counts[c.key] };
  });
  const max = Math.max(...rows.map((r) => Math.max(r.obs, r.th))) * 1.08 || 1;
  return `
    <div class="legend"><span><i class="lg-bar"></i>実際</span><span><i class="lg-tick"></i>理論値</span></div>
    <div class="hb">
      ${rows.map((r) => {
        const tip = `<b>${esc(r.c.label)}</b><br>実際 ${pct(r.obs)}（${r.k}回）<br>理論値 ${pct(r.th)}${r.cmp != null ? `<br>全体平均 ${pct(r.cmp)}` : ''}`;
        return `<div class="hb-row" tabindex="0" data-tip="${esc(tip)}">
          <span class="hb-label">${esc(r.c.label)}</span>
          <span class="hb-track"><span class="hb-bar" style="width:${(r.obs / max) * 100}%"></span><span class="hb-tick" style="left:${(r.th / max) * 100}%"></span></span>
          <span class="hb-val">${pct(r.obs)}</span>
          <span class="hb-n">${r.k}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ---------- 概要 ----------
function overview(ctx) {
  const { res, settings, h, sr } = ctx;
  const t = res.total;
  const rounds = res.rounds.filter((rd) => rd.records.some((r) => r.rank != null)).length;
  const list = insights(res, settings, h.nameOf);
  const board = res.users.filter((u) => u.n > 0).sort((a, b) => (rate(b.winScore, b.rounds) ?? -1) - (rate(a.winScore, a.rounds) ?? -1));
  return `
    <div class="kpis">
      ${kpi('ターン', t.n)}
      ${kpi('周', rounds)}
      ${kpi('役あり率', pct(rate(t.counts.yaku, t.n)), `理論 ${pct(theoreticalFor(GROUPS[3].hands, sr))}`)}
      ${kpi('シゴロ以上', pct(rate(t.counts.strong, t.n)), `理論 ${pct(theoreticalFor(GROUPS[1].hands, sr))}`)}
    </div>

    ${list.length ? `<section class="card pad">
      <h2 class="section-title">注目ポイント</h2>
      <ul class="insights">${list.map((x) => `
        <li class="insight">
          <span class="insight-emoji" aria-hidden="true">${x.emoji}</span>
          <div class="insight-main">
            <div class="insight-title">${esc(x.title)}</div>
            <div class="insight-who">${avatar(h.person(x.who), 'xs')}<b>${esc(x.name)}</b></div>
            <div class="insight-text">${esc(x.text)}</div>
          </div>
        </li>`).join('')}</ul>
    </section>` : ''}

    <section class="card pad">
      <h2 class="section-title">役の出現率</h2>
      <p class="section-sub">1ターン最大3投で、最終的に出た役の割合</p>
      ${handBars(t, ctx)}
    </section>

    <section class="card">
      <h2 class="section-title pad-x pt">最強・最弱</h2>
      <table class="table">
        <thead><tr><th>メンバー</th><th class="num">周</th><th class="num">最強</th><th class="num">最弱</th><th class="num" data-tip="${esc('周ごとの順位を 1位=100%、ビリ=0% に換算した平均')}" tabindex="0">勝ちっぷり</th></tr></thead>
        <tbody>${board.map((u) => `
          <tr>
            <td><span class="cell-person">${avatar(h.person(u.uid), 'xs')}${esc(h.nameOf(u.uid))}</span></td>
            <td class="num">${u.rounds}</td>
            <td class="num">${u.top}</td>
            <td class="num">${u.bottom}</td>
            <td class="num"><span class="meter"><i style="width:${(rate(u.winScore, u.rounds) ?? 0) * 100}%"></i></span>${pct(rate(u.winScore, u.rounds), 0)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </section>`;
}

// ---------- 個人 ----------
function personView(ctx) {
  const { S, h, res, sr } = ctx;
  const st = S.stats;
  const withData = res.users.filter((u) => u.n > 0 || u.skips > 0);
  const ids = [...new Set([...S.group.members.map((m) => m.uid), ...withData.map((u) => u.uid)])];
  if (!withData.some((u) => u.uid === st.member)) st.member = withData.find((u) => u.uid === app.me.uid)?.uid || withData[0]?.uid || st.member;
  const u = res.users.find((x) => x.uid === st.member);
  const picker = `<div class="chips people" aria-label="メンバー">${ids.map((id) => {
    const has = withData.some((x) => x.uid === id);
    return `<button class="chip person ${id === st.member ? 'on' : ''}" data-member="${esc(id)}" ${has ? '' : 'disabled'}>${avatar(h.person(id), 'xs')}${esc(h.nameOf(id))}</button>`;
  }).join('')}</div>`;
  if (!u || u.n === 0) return `${picker}<div class="empty card"><p class="empty-title">この期間の記録がありません</p></div>`;

  const p = h.person(u.uid);
  const theo = theoreticalHandProbs(sr);
  // 偏りレポート：理論値との差が大きいものから
  const sets = [...CATEGORIES, GROUPS[0], GROUPS[1]].filter((c) => !c.optional || ctx.hasShonben);
  const bias = sets.map((c) => {
    const th = c.hands.reduce((s, x) => s + theo[x], 0);
    const k = u.counts[c.key];
    const z = zScore(k, u.n, th);
    const groupRate = rate(res.total.counts[c.key], res.total.n);
    return { c, th, k, obs: k / u.n, z, word: biasWord(z), groupRate };
  }).filter((b) => b.word && (b.z < 0 || b.k >= 2)).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 5);
  const fb = faceBias(u.faces);
  const facesTotal = u.faces.reduce((a, b) => a + b, 0);
  const maxFace = Math.max(...u.faces, facesTotal / 6) || 1;
  const h2h = headToHead(ctx.recs)[u.uid] || {};
  const recent = u.seq.slice(-30);

  const againRows = CATEGORIES.filter((c) => u.counts[c.key] > 0).map((c) => {
    const a = u.after[c.key] || { prev: 0, again: 0 };
    return { c, count: u.counts[c.key], a, th: c.hands.reduce((s, x) => s + theo[x], 0) };
  });

  return `
    ${picker}
    <section class="card person-head">
      ${avatar(p, 'xl')}
      <div>
        <div class="person-name">${esc(p.name)}</div>
        <div class="person-meta">${u.n}ターン · ${u.rounds}周${u.skips ? ` · スキップ${u.skips}回` : ''}${u.proxied ? ` · 代理${u.proxied}回` : ''}</div>
      </div>
    </section>

    <div class="kpis">
      ${kpi('最強率', pct(rate(u.top, u.rounds)), `${u.top}/${u.rounds}周`)}
      ${kpi('最弱率', pct(rate(u.bottom, u.rounds)), `${u.bottom}/${u.rounds}周`)}
      ${kpi('役あり率', pct(rate(u.counts.yaku, u.n)), `理論 ${pct(theoreticalFor(GROUPS[3].hands, sr))}`)}
      ${kpi('1投目で決着', pct(rate(u.firstRoll, u.n)), `平均 ${(u.rolls / u.n).toFixed(2)}投`)}
    </div>

    <section class="card pad">
      <h2 class="section-title">偏りレポート</h2>
      <p class="section-sub">理論値と比べて、出やすい・出にくい役</p>
      ${u.n < 10 ? '<p class="muted">10ターン以上たまると偏りを判定します。</p>' : bias.length ? `<ul class="bias">${bias.map((b) => `
        <li class="bias-row ${b.z > 0 ? 'up' : 'down'}">
          <span class="bias-arrow" aria-hidden="true">${b.z > 0 ? '↑' : '↓'}</span>
          <div class="bias-main">
            <div class="bias-title"><b>${esc(b.c.label)}</b>が${b.word}</div>
            <div class="bias-text">${pct(b.obs)}（${b.k}回）· 理論 ${pct(b.th)} の${(b.obs / b.th).toFixed(1)}倍 · 全体 ${pct(b.groupRate)}</div>
          </div>
        </li>`).join('')}</ul>` : '<p class="muted">大きな偏りはありません。ほぼ理論どおりです。</p>'}
    </section>

    <section class="card pad">
      <h2 class="section-title">役の出現率</h2>
      ${handBars(u, ctx, res.total)}
    </section>

    <section class="card pad">
      <h2 class="section-title">サイコロの目</h2>
      <p class="section-sub">振ったサイコロ${facesTotal}個の内訳（理論値は各16.7%）</p>
      <div class="faces">
        ${u.faces.map((n, i) => `<div class="face" tabindex="0" data-tip="${esc(`<b>${i + 1}</b>　${n}回（${pct(rate(n, facesTotal))}）`)}">
          <div class="face-col"><i style="height:${(n / maxFace) * 100}%"></i><span class="face-tick" style="bottom:${(facesTotal / 6 / maxFace) * 100}%"></span></div>
          <div class="face-val">${pct(rate(n, facesTotal), 0)}</div>
          <div class="face-die">${dieIcon(i + 1)}</div>
        </div>`).join('')}
      </div>
      <p class="verdict">${fb.p == null ? 'サイコロ30個以上で偏りを判定します。' : fb.p < 0.01 ? `<b>かなり偏っています</b>（偶然この偏りになる確率 ${pct(fb.p)}）` : fb.p < 0.05 ? `<b>やや偏っています</b>（偶然この偏りになる確率 ${pct(fb.p)}）` : `偏りなし（偶然の範囲内・p=${fb.p.toFixed(2)}）`}</p>
    </section>

    <section class="card">
      <h2 class="section-title pad-x pt">連続</h2>
      <div class="kpis inner">
        ${kpi('最長 役あり連続', `${u.streak.yaku}`)}
        ${kpi('最長 ハズレ連続', `${u.streak.bad}`)}
        ${kpi('最長 目なし連続', `${u.streak.menashi}`)}
        ${kpi('同じ役が2連続', pct(rate(u.samePairs, u.pairs)), `${u.samePairs}/${u.pairs}回`)}
      </div>
      <table class="table">
        <thead><tr><th>役</th><th class="num">回数</th><th class="num" data-tip="その役を出した次のターンで、また同じ役を出した割合" tabindex="0">次も同じ</th><th class="num">理論</th></tr></thead>
        <tbody>${againRows.map((r) => `
          <tr>
            <td><span class="hand-chip t-${tierOf(r.c.hands[0])}">${esc(r.c.label)}</span></td>
            <td class="num">${r.count}</td>
            <td class="num">${r.a.prev ? `${pct(rate(r.a.again, r.a.prev))}<small>${r.a.again}/${r.a.prev}</small>` : '—'}</td>
            <td class="num muted">${pct(r.th)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </section>

    <section class="card pad">
      <h2 class="section-title">最近の出目</h2>
      <p class="section-sub">新しい順に${recent.length}ターン</p>
      <div class="timeline">${[...recent].reverse().map((x) => handChip(x)).join('')}</div>
    </section>

    ${Object.keys(h2h).length ? `<section class="card">
      <h2 class="section-title pad-x pt">対戦成績</h2>
      <p class="section-sub pad-x">同じ周で比べた勝ち・負け・引き分け</p>
      <ul class="vs-list">${Object.entries(h2h).sort((a, b) => (b[1].w + b[1].l + b[1].d) - (a[1].w + a[1].l + a[1].d)).map(([opp, r]) => {
        const games = r.w + r.l + r.d;
        return `<li class="vs-row">
          ${avatar(h.person(opp), 'sm')}
          <span class="vs-name">${esc(h.nameOf(opp))}</span>
          <span class="vs-bar" aria-hidden="true"><i class="w" style="flex:${r.w}"></i><i class="d" style="flex:${r.d}"></i><i class="l" style="flex:${r.l}"></i></span>
          <span class="vs-score"><b>${r.w}</b>勝 ${r.l}敗${r.d ? ` ${r.d}分` : ''}</span>
          <span class="vs-rate">${pct(rate(r.w, games), 0)}</span>
        </li>`;
      }).join('')}</ul>
    </section>` : ''}`;
}

function dieIcon(v) {
  const P = { 1: [[12, 12]], 2: [[17, 7], [7, 17]], 3: [[17, 7], [12, 12], [7, 17]], 4: [[7, 7], [17, 7], [7, 17], [17, 17]], 5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]], 6: [[7, 6.5], [17, 6.5], [7, 12], [17, 12], [7, 17.5], [17, 17.5]] };
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-label="${v}"><rect x="1.5" y="1.5" width="21" height="21" rx="5.5" class="di-body"/>${P[v].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${v === 1 ? 3.6 : 2.1}" class="${v === 1 ? 'di-one' : 'di-pip'}"/>`).join('')}</svg>`;
}

// ---------- ランキング ----------
function ranking(ctx) {
  const { S, h, res, settings, hasShonben } = ctx;
  const metrics = buildMetrics(settings, hasShonben);
  let metric = metrics.find((m) => m.key === S.stats.metric);
  if (!metric) { metric = metrics[0]; S.stats.metric = metric.key; }
  const { rows, few } = rankBy(metric, res.users.filter((u) => u.n > 0 || u.skips > 0));
  const fmt = (v) => (v == null ? '—' : metric.unit === 'pct' ? pct(v) : metric.digits ? v.toFixed(metric.digits) : String(v));
  const max = Math.max(...rows.map((r) => r.value), metric.theory || 0) * 1.05 || 1;
  const sections = [...new Set(metrics.map((m) => m.section))];
  const label = (k) => QUICK_LABEL[k] || metrics.find((m) => m.key === k)?.label || k;

  const row = (r, faded = false) => `
    <li class="rank-row ${faded ? 'faded' : ''} ${r.rank === 1 && !faded ? 'first' : ''} ${r.uid === app.me.uid ? 'me' : ''}">
      <span class="rank-no">${faded ? '–' : r.rank}</span>
      ${avatar(h.person(r.uid), 'md')}
      <div class="rank-main">
        <div class="rank-name">${esc(h.nameOf(r.uid))}</div>
        <div class="rank-track"><i style="width:${r.value != null ? (r.value / max) * 100 : 0}%"></i>${metric.theory ? `<span class="rank-tick" style="left:${(metric.theory / max) * 100}%"></span>` : ''}</div>
      </div>
      <div class="rank-val">
        <b>${fmt(r.value)}</b>
        ${r.num != null ? `<small>${r.num}/${r.den}</small>` : r.den != null && metric.unit === 'pct' ? `<small>${r.den}周</small>` : ''}
      </div>
    </li>`;

  return `
    <div class="chips" aria-label="よく見る指標">
      ${QUICK_METRICS.filter((k) => metrics.some((m) => m.key === k)).map((k) => `<button class="chip ${k === metric.key ? 'on' : ''}" data-metric="${k}">${esc(label(k))}</button>`).join('')}
    </div>
    <label class="select-wrap">
      <span class="sr-only">指標を選ぶ</span>
      <select data-metric-select>
        ${sections.map((s) => `<optgroup label="${esc(s)}">${metrics.filter((m) => m.section === s).map((m) => `<option value="${m.key}" ${m.key === metric.key ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</optgroup>`).join('')}
      </select>
    </label>
    <section class="card">
      <div class="rank-head pad-x pt">
        <h2 class="section-title">${esc(metric.label)}</h2>
        ${metric.theory ? `<span class="legend inline"><span><i class="lg-tick"></i>理論値 ${pct(metric.theory)}</span></span>` : ''}
      </div>
      ${rows.length ? `<ol class="rank-list">${rows.map((r) => row(r)).join('')}</ol>` : '<p class="muted pad-x pb">データがまだ足りません。</p>'}
      ${few.length ? `<div class="rank-few"><p class="hint pad-x">サンプル不足（${metric.unit === 'pct' ? `${MIN_SAMPLE}未満` : 'データなし'}）</p><ol class="rank-list">${few.map((r) => row(r, true)).join('')}</ol></div>` : ''}
    </section>`;
}

// ---------- 対戦表 ----------
function h2hView(ctx) {
  const { h, recs, res } = ctx;
  const table = headToHead(recs);
  const ids = res.users.filter((u) => u.rounds > 0).map((u) => u.uid);
  if (ids.length < 2) return '<div class="empty card"><p class="empty-title">対戦データがまだありません</p><p class="empty-text">2人以上で1周すると表示されます。</p></div>';
  return `
    <section class="card pad">
      <h2 class="section-title">対戦表</h2>
      <p class="section-sub">行の人から見た、同じ周での勝ち-負け</p>
      <div class="matrix-scroll">
        <table class="matrix">
          <thead><tr><th></th>${ids.map((id) => `<th title="${esc(h.nameOf(id))}">${avatar(h.person(id), 'sm')}</th>`).join('')}</tr></thead>
          <tbody>${ids.map((a) => `
            <tr><th class="matrix-name">${avatar(h.person(a), 'sm')}<span class="mx-name">${esc(h.nameOf(a))}</span></th>
            ${ids.map((b) => {
              if (a === b) return '<td class="self"></td>';
              const r = table[a]?.[b];
              const games = r ? r.w + r.l + r.d : 0;
              if (!games) return '<td class="none">—</td>';
              const wr = r.w / (r.w + r.l || 1);
              const tip = `<b>${esc(h.nameOf(a))}</b> vs ${esc(h.nameOf(b))}<br>${r.w}勝 ${r.l}敗 ${r.d}分`;
              return `<td style="--wr:${wr}" class="${wr > 0.5 ? 'win' : wr < 0.5 ? 'lose' : 'even'}" tabindex="0" data-tip="${esc(tip)}">${r.w}-${r.l}</td>`;
            }).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="legend"><span><i class="lg-sq win"></i>勝ち越し</span><span><i class="lg-sq lose"></i>負け越し</span></div>
    </section>`;
}

const VIEW_RENDER = { overview, person: personView, ranking, h2h: h2hView };
