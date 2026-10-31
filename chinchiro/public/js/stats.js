// 分析シート（概要・個人・ランキング・対戦）
import { esc, handChip, tierOf, pct, dot, fgFor } from './ui.js';
import { CATEGORIES, GROUPS, theoreticalHandProbs, theoreticalFor } from './rules.js';
import {
  PERIODS, DAY_START_HOUR, MIN_SAMPLE, filterRecords, periodRange, analyze, buildMetrics, rankBy,
  headToHead, insights, faceBias, zScore, biasWord, rate,
} from './analysis.js';

const VIEWS = [['overview', '概要'], ['person', '個人'], ['ranking', 'ランキング'], ['h2h', '対戦']];
const QUICK_METRICS = ['hand:shigoro', 'hand:arashi', 'hand:pinzoro', 'hand:hifumi', 'hand:menashi', 'top', 'bottom', 'again:hifumi'];
const QUICK_LABEL = { top: '最強率', bottom: '最弱率', 'again:hifumi': 'ヒフミ連続' };
const YAKU = GROUPS.find((g) => g.key === 'yaku').hands;
const STRONG = GROUPS.find((g) => g.key === 'strong').hands;

/**
 * ctx: { records, settings, members:[{uid}], me, state, person(uid), nameOf(uid), rerender() }
 */
export function renderStats(el, ctx) {
  const st = ctx.state;
  const recs = filterRecords(ctx.records, st.period, Date.now(), st.custom);
  const res = analyze(recs);
  const hasShonben = recs.some((r) => r.h === 'shonben');
  const c = { ...ctx, res, recs, hasShonben, sr: ctx.settings.shonben ? ctx.settings.shonbenRate : 0 };

  el.innerHTML = `
    <div class="chips" aria-label="期間">
      ${PERIODS.map((p) => `<button class="chip ${st.period === p.key ? 'on' : ''}" data-period="${p.key}">${p.label}</button>`).join('')}
    </div>
    ${st.period === 'custom' ? `<div class="dates">
        <label>開始<input type="date" data-date="from" value="${esc(st.custom.from || '')}"></label>
        <span>〜</span>
        <label>終了<input type="date" data-date="to" value="${esc(st.custom.to || '')}"></label>
      </div>` : ''}
    <p class="hint">${esc(periodText(st))} · ${res.total.n}ターン</p>
    <div class="tabs flat" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" data-view="${k}" aria-selected="${st.view === k}">${l}</button>`).join('')}</div>
    ${res.total.n === 0 ? `<p class="empty-note">この期間の記録はありません。<br>1日の区切りは朝${DAY_START_HOUR}時です。</p>` : VIEW_RENDER[st.view](c)}`;

  const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach((x) => x.addEventListener(ev, () => fn(x)));
  on('[data-period]', 'click', (b) => { st.period = b.dataset.period; ctx.rerender(); });
  on('[data-view]', 'click', (b) => { st.view = b.dataset.view; ctx.rerender(); });
  on('[data-date]', 'change', (i) => { st.custom[i.dataset.date] = i.value; ctx.rerender(); });
  on('[data-member]', 'click', (b) => { st.member = b.dataset.member; ctx.rerender(); });
  on('[data-metric]', 'click', (b) => { st.metric = b.dataset.metric; ctx.rerender(); });
  on('[data-metric-select]', 'change', (s) => { st.metric = s.value; ctx.rerender(); });
  on('[data-tip]', 'click', (x) => { el.querySelectorAll('.tipped').forEach((y) => y !== x && y.classList.remove('tipped')); x.classList.toggle('tipped'); });
  el.querySelector('.chips .chip.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function periodText(st) {
  const fmt = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  if (st.period === 'all') return '全期間（保存されている最新1000件ほど）';
  if (st.period === 'last100') return 'ルーム全体の直近100ターン';
  if (st.period === 'last10rounds') return '直近10周';
  const r = periodRange(st.period, Date.now(), st.custom);
  if (!r) return '';
  const from = Number.isFinite(r[0]) ? `${fmt(r[0])} ${DAY_START_HOUR}:00` : 'はじめ';
  const to = Number.isFinite(r[1]) ? `${fmt(r[1])} ${DAY_START_HOUR}:00` : '現在';
  return `${from} 〜 ${to}`;
}

const kpi = (label, value, sub = '') => `<div class="kpi"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
const who = (c, u) => `${dot(c.person(u).color)}<b>${esc(c.nameOf(u))}</b>`;

// ---------- 役の出現率（実際＝棒、理論値＝赤い縦線） ----------
function handBars(stats, c, compare) {
  const theo = theoreticalHandProbs(c.sr);
  const cats = CATEGORIES.filter((x) => !x.optional || c.settings.shonben || c.hasShonben);
  const rows = cats.map((x) => ({
    x,
    obs: rate(stats.counts[x.key], stats.n) ?? 0,
    th: x.hands.reduce((s, h) => s + theo[h], 0),
    cmp: compare ? rate(compare.counts[x.key], compare.n) : null,
    k: stats.counts[x.key],
  }));
  const max = Math.max(...rows.map((r) => Math.max(r.obs, r.th))) * 1.08 || 1;
  return `<div class="legend"><span><i class="lg-bar"></i>実際</span><span><i class="lg-tick"></i>理論値</span></div>
    <div class="hb">${rows.map((r) => `
      <div class="hb-row" data-tip tabindex="0">
        <span class="hb-label">${esc(r.x.label)}</span>
        <span class="hb-track"><span class="hb-bar t-${tierOf(r.x.hands[0])}" style="width:${(r.obs / max) * 100}%"></span><span class="hb-tick" style="left:${(r.th / max) * 100}%"></span></span>
        <span class="hb-val">${pct(r.obs)}</span>
        <span class="hb-n">${r.k}</span>
        <span class="tip">実際 ${pct(r.obs)}（${r.k}回） · 理論 ${pct(r.th)}${r.cmp != null ? ` · 全体 ${pct(r.cmp)}` : ''}</span>
      </div>`).join('')}</div>`;
}

// ---------- 概要 ----------
function overview(c) {
  const t = c.res.total;
  const rounds = c.res.rounds.filter((rd) => rd.records.some((r) => r.rank != null)).length;
  const list = insights(c.res, c.settings, c.nameOf);
  const board = c.res.users.filter((u) => u.n > 0).sort((a, b) => (rate(b.winScore, b.rounds) ?? -1) - (rate(a.winScore, a.rounds) ?? -1));
  return `
    <div class="kpis">
      ${kpi('ターン', t.n)}
      ${kpi('周', rounds)}
      ${kpi('役あり率', pct(rate(t.counts.yaku, t.n)), `理論 ${pct(theoreticalFor(YAKU, c.sr))}`)}
      ${kpi('シゴロ以上', pct(rate(t.counts.strong, t.n)), `理論 ${pct(theoreticalFor(STRONG, c.sr))}`)}
    </div>
    ${list.length ? `<section class="blk"><h3>注目ポイント</h3><ul class="ins">${list.map((x) => `
      <li><span class="ins-e" aria-hidden="true">${x.emoji}</span><div><small>${esc(x.title)}</small><p>${who(c, x.who)}</p><span>${esc(x.text)}</span></div></li>`).join('')}</ul></section>` : ''}
    <section class="blk"><h3>役の出現率</h3><p class="sub">1ターン最大3投で、最終的に出た役の割合</p>${handBars(t, c)}</section>
    <section class="blk"><h3>最強・最弱</h3>
      <table class="tbl"><thead><tr><th>メンバー</th><th class="n">周</th><th class="n">最強</th><th class="n">最弱</th><th class="n">勝ちっぷり</th></tr></thead>
      <tbody>${board.map((u) => `<tr><td><span class="cp">${who(c, u.uid)}</span></td><td class="n">${u.rounds}</td><td class="n">${u.top}</td><td class="n">${u.bottom}</td><td class="n">${pct(rate(u.winScore, u.rounds), 0)}</td></tr>`).join('')}</tbody></table>
      <p class="sub">勝ちっぷり＝周ごとの順位を「1位=100%・ビリ=0%」に換算した平均</p>
    </section>`;
}

// ---------- 個人 ----------
function personView(c) {
  const st = c.state;
  const withData = c.res.users.filter((u) => u.n > 0 || u.skips > 0);
  const ids = [...new Set([...c.members.map((m) => m.uid), ...withData.map((u) => u.uid)])];
  if (!withData.some((u) => u.uid === st.member)) st.member = withData.find((u) => u.uid === c.me)?.uid || withData[0]?.uid || st.member;
  const u = c.res.users.find((x) => x.uid === st.member);
  const picker = `<div class="chips">${ids.map((id) => {
    const has = withData.some((x) => x.uid === id);
    return `<button class="chip ${id === st.member ? 'on' : ''}" data-member="${esc(id)}" ${has ? '' : 'disabled'}>${dot(c.person(id).color)}${esc(c.nameOf(id))}</button>`;
  }).join('')}</div>`;
  if (!u || u.n === 0) return `${picker}<p class="empty-note">この期間の記録がありません</p>`;

  const p = c.person(u.uid);
  const theo = theoreticalHandProbs(c.sr);
  const sets = [...CATEGORIES, GROUPS[0], GROUPS[1]].filter((x) => !x.optional || c.hasShonben);
  const bias = sets.map((x) => {
    const th = x.hands.reduce((s, h) => s + theo[h], 0);
    const k = u.counts[x.key];
    const z = zScore(k, u.n, th);
    return { x, th, k, obs: k / u.n, z, word: biasWord(z), all: rate(c.res.total.counts[x.key], c.res.total.n) };
  }).filter((b) => b.word && (b.z < 0 || b.k >= 2)).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 5);
  const fb = faceBias(u.faces);
  const ft = u.faces.reduce((a, b) => a + b, 0);
  const fmax = Math.max(...u.faces, ft / 6) || 1;
  const h2h = headToHead(c.recs)[u.uid] || {};
  const again = CATEGORIES.filter((x) => u.counts[x.key] > 0).map((x) => ({ x, count: u.counts[x.key], a: u.after[x.key] || { prev: 0, again: 0 }, th: x.hands.reduce((s, h) => s + theo[h], 0) }));

  return `${picker}
    <section class="phead" style="--c:${esc(p.color)};--fg:${fgFor(p.color)}"><b>${esc(p.name)}</b><span>${u.n}ターン · ${u.rounds}周${u.skips ? ` · スキップ${u.skips}回` : ''}${u.proxied ? ` · 代理${u.proxied}回` : ''}</span></section>
    <div class="kpis">
      ${kpi('最強率', pct(rate(u.top, u.rounds)), `${u.top}/${u.rounds}周`)}
      ${kpi('最弱率', pct(rate(u.bottom, u.rounds)), `${u.bottom}/${u.rounds}周`)}
      ${kpi('役あり率', pct(rate(u.counts.yaku, u.n)), `理論 ${pct(theoreticalFor(YAKU, c.sr))}`)}
      ${kpi('1投目で決着', pct(rate(u.firstRoll, u.n)), `平均 ${(u.rolls / u.n).toFixed(2)}投`)}
    </div>
    <section class="blk"><h3>偏りレポート</h3><p class="sub">理論値と比べて、出やすい・出にくい役</p>
      ${u.n < 10 ? '<p class="sub">10ターン以上たまると判定します。</p>' : bias.length ? `<ul class="bias">${bias.map((b) => `
        <li class="${b.z > 0 ? 'up' : 'down'}"><i>${b.z > 0 ? '↑' : '↓'}</i><div><p><b>${esc(b.x.label)}</b>が${b.word}</p>
        <span>${pct(b.obs)}（${b.k}回）· 理論 ${pct(b.th)} の${(b.obs / b.th).toFixed(1)}倍 · 全体 ${pct(b.all)}</span></div></li>`).join('')}</ul>` : '<p class="sub">大きな偏りはありません。ほぼ理論どおりです。</p>'}
    </section>
    <section class="blk"><h3>役の出現率</h3>${handBars(u, c, c.res.total)}</section>
    <section class="blk"><h3>サイコロの目</h3><p class="sub">振ったサイコロ${ft}個の内訳（理論値は各16.7%）</p>
      <div class="faces">${u.faces.map((n, i) => `<div class="face">
        <div class="fcol"><i style="height:${(n / fmax) * 100}%"></i><span style="bottom:${(ft / 6 / fmax) * 100}%"></span></div>
        <small>${pct(rate(n, ft), 0)}</small><span class="md" data-v="${i + 1}">${pipsOf(i + 1)}</span></div>`).join('')}</div>
      <p class="verdict">${fb.p == null ? 'サイコロ30個以上で偏りを判定します。' : fb.p < 0.01 ? `<b>かなり偏っています</b>（偶然この偏りになる確率 ${pct(fb.p)}）` : fb.p < 0.05 ? `<b>やや偏っています</b>（偶然この偏りになる確率 ${pct(fb.p)}）` : `偏りなし（偶然の範囲内・p=${fb.p.toFixed(2)}）`}</p>
    </section>
    <section class="blk"><h3>連続</h3>
      <div class="kpis in">
        ${kpi('最長 役あり連続', u.streak.yaku)}${kpi('最長 ハズレ連続', u.streak.bad)}
        ${kpi('最長 目なし連続', u.streak.menashi)}${kpi('同じ役が2連続', pct(rate(u.samePairs, u.pairs)), `${u.samePairs}/${u.pairs}回`)}
      </div>
      <table class="tbl"><thead><tr><th>役</th><th class="n">回数</th><th class="n">次も同じ</th><th class="n">理論</th></tr></thead>
      <tbody>${again.map((r) => `<tr><td>${handChip(r.x.hands[0], r.x.label)}</td><td class="n">${r.count}</td>
        <td class="n">${r.a.prev ? `${pct(rate(r.a.again, r.a.prev))}<small>${r.a.again}/${r.a.prev}</small>` : '—'}</td><td class="n mu">${pct(r.th)}</td></tr>`).join('')}</tbody></table>
      <p class="sub">次も同じ＝その役を出した次のターンで、また同じ役を出した割合（例：ヒフミの次もヒフミ）</p>
    </section>
    <section class="blk"><h3>最近の出目</h3><p class="sub">新しい順に${Math.min(30, u.seq.length)}ターン</p>
      <div class="tl">${u.seq.slice(-30).reverse().map((h) => handChip(h)).join('')}</div></section>
    ${Object.keys(h2h).length ? `<section class="blk"><h3>対戦成績</h3><p class="sub">同じ周で比べた勝ち・負け・引き分け</p>
      <ul class="vs">${Object.entries(h2h).sort((a, b) => (b[1].w + b[1].l + b[1].d) - (a[1].w + a[1].l + a[1].d)).map(([o, r]) => {
        const games = r.w + r.l + r.d;
        return `<li>${who(c, o)}<span class="vbar"><i class="w" style="flex:${r.w}"></i><i class="d" style="flex:${r.d}"></i><i class="l" style="flex:${r.l}"></i></span><span class="vsc">${r.w}勝${r.l}敗${r.d ? `${r.d}分` : ''}</span><b class="vr">${pct(rate(r.w, games), 0)}</b></li>`;
      }).join('')}</ul></section>` : ''}`;
}

const PIP_POS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const pipsOf = (v) => Array.from({ length: 9 }, (_, i) => (PIP_POS[v].includes(i + 1) ? '<i class="p"></i>' : '<i></i>')).join('');

// ---------- ランキング ----------
function ranking(c) {
  const st = c.state;
  const metrics = buildMetrics(c.settings, c.hasShonben);
  let m = metrics.find((x) => x.key === st.metric);
  if (!m) { m = metrics[0]; st.metric = m.key; }
  const { rows, few } = rankBy(m, c.res.users.filter((u) => u.n > 0 || u.skips > 0));
  const fmt = (v) => (v == null ? '—' : m.unit === 'pct' ? pct(v) : m.digits ? v.toFixed(m.digits) : String(v));
  const max = Math.max(...rows.map((r) => r.value), m.theory || 0) * 1.05 || 1;
  const sections = [...new Set(metrics.map((x) => x.section))];
  const label = (k) => QUICK_LABEL[k] || metrics.find((x) => x.key === k)?.label || k;
  const row = (r, faded) => {
    const p = c.person(r.uid);
    return `<li class="${faded ? 'faded' : ''} ${r.rank === 1 && !faded ? 'first' : ''} ${r.uid === c.me ? 'me' : ''}" style="--c:${esc(p.color)};--fg:${fgFor(p.color)}">
      <b class="rk">${faded ? '–' : r.rank}</b>
      <div class="rm"><span>${esc(p.name)}</span><span class="rt"><i style="width:${r.value != null ? (r.value / max) * 100 : 0}%"></i>${m.theory ? `<em style="left:${(m.theory / max) * 100}%"></em>` : ''}</span></div>
      <div class="rv"><b>${fmt(r.value)}</b>${r.num != null ? `<small>${r.num}/${r.den}</small>` : ''}</div>
    </li>`;
  };
  return `
    <div class="chips">${QUICK_METRICS.filter((k) => metrics.some((x) => x.key === k)).map((k) => `<button class="chip ${k === m.key ? 'on' : ''}" data-metric="${k}">${esc(label(k))}</button>`).join('')}</div>
    <select class="sel" data-metric-select aria-label="指標を選ぶ">${sections.map((s) => `<optgroup label="${esc(s)}">${metrics.filter((x) => x.section === s).map((x) => `<option value="${x.key}" ${x.key === m.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`).join('')}</select>
    <section class="blk"><div class="rhead"><h3>${esc(m.label)}</h3>${m.theory ? `<span class="legend in"><span><i class="lg-tick"></i>理論値 ${pct(m.theory)}</span></span>` : ''}</div>
      ${rows.length ? `<ol class="rank">${rows.map((r) => row(r, false)).join('')}</ol>` : '<p class="sub">データがまだ足りません。</p>'}
      ${few.length ? `<p class="sub">サンプル不足（${m.unit === 'pct' ? `${MIN_SAMPLE}未満` : 'データなし'}）</p><ol class="rank">${few.map((r) => row(r, true)).join('')}</ol>` : ''}
    </section>`;
}

// ---------- 対戦表 ----------
function h2hView(c) {
  const table = headToHead(c.recs);
  const ids = c.res.users.filter((u) => u.rounds > 0).map((u) => u.uid);
  if (ids.length < 2) return '<p class="empty-note">対戦データがまだありません。<br>2人以上で1周すると表示されます。</p>';
  return `<section class="blk"><h3>対戦表</h3><p class="sub">行の人から見た、同じ周での勝ち-負け</p>
    <div class="mx-wrap"><table class="mx">
      <thead><tr><th></th>${ids.map((id) => `<th>${dot(c.person(id).color)}</th>`).join('')}</tr></thead>
      <tbody>${ids.map((a) => `<tr><th>${dot(c.person(a).color)}<span>${esc(c.nameOf(a))}</span></th>${ids.map((b) => {
        if (a === b) return '<td class="self"></td>';
        const r = table[a]?.[b];
        if (!r || !(r.w + r.l + r.d)) return '<td class="none">—</td>';
        const wr = r.w / (r.w + r.l || 1);
        return `<td class="${wr > 0.5 ? 'win' : wr < 0.5 ? 'lose' : ''}" style="--wr:${wr}">${r.w}-${r.l}</td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="legend"><span><i class="lg-sq win"></i>勝ち越し</span><span><i class="lg-sq lose"></i>負け越し</span></div></section>`;
}

const VIEW_RENDER = { overview, person: personView, ranking, h2h: h2hView };
