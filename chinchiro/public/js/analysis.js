// 記録の集計・分析（純粋関数。ブラウザとテストで共用）
import { HANDS, CATEGORIES, GROUPS, categoryOf, strengthOf, theoreticalFor, theoreticalFirstRoll } from './rules.js';

export const DAY_START_HOUR = 5; // 飲み会は日付をまたぐので、朝5時を1日の区切りにする
export const MIN_SAMPLE = 5;

// ---------- 期間フィルター ----------
export const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'last100', label: '直近100回' },
  { key: 'last10rounds', label: '直近10周' },
  { key: 'thisWeek', label: '今週' },
  { key: 'lastWeek', label: '先週' },
  { key: 'thisMonth', label: '今月' },
  { key: 'all', label: '全期間' },
  { key: 'custom', label: '期間指定' },
];

/** その時刻が属する「1日」の開始時刻（朝5時区切り） */
export function dayStart(ts) {
  const d = new Date(ts);
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  return d.getTime();
}

const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };

function weekStart(ts) {
  const ds = dayStart(ts);
  const dow = (new Date(ds).getDay() + 6) % 7; // 月曜=0
  return addDays(ds, -dow);
}

/** 期間キーから [開始, 終了) の時刻範囲を返す。件数ベースの期間は null。 */
export function periodRange(key, now = Date.now(), custom = {}) {
  const today = dayStart(now);
  switch (key) {
    case 'today': return [today, Infinity];
    case 'yesterday': return [addDays(today, -1), today];
    case 'thisWeek': return [weekStart(now), Infinity];
    case 'lastWeek': { const w = weekStart(now); return [addDays(w, -7), w]; }
    case 'thisMonth': {
      const d = new Date(today);
      d.setDate(1);
      return [d.getTime(), Infinity];
    }
    case 'custom': {
      const from = custom.from ? dayStart(new Date(`${custom.from}T12:00:00`).getTime()) : -Infinity;
      const to = custom.to ? addDays(dayStart(new Date(`${custom.to}T12:00:00`).getTime()), 1) : Infinity;
      return [from, to];
    }
    default: return null;
  }
}

/** 期間で記録を絞り込む（スキップ記録も含めて返す） */
export function filterRecords(records, key, now = Date.now(), custom = {}) {
  if (key === 'all') return records;
  if (key === 'last100') {
    const played = records.filter((r) => r.h !== 'skip');
    const cutoff = played.length > 100 ? played[played.length - 100].id : -Infinity;
    return records.filter((r) => r.id >= cutoff);
  }
  if (key === 'last10rounds') {
    const rounds = [...new Set(records.map((r) => r.r))].slice(-10);
    const set = new Set(rounds);
    return records.filter((r) => set.has(r.r));
  }
  const range = periodRange(key, now, custom);
  if (!range) return records;
  return records.filter((r) => r.t >= range[0] && r.t < range[1]);
}

// ---------- 集計 ----------
const ALL_SETS = [...CATEGORIES, ...GROUPS];
const SET_OF_HAND = {};
for (const s of ALL_SETS) for (const h of s.hands) (SET_OF_HAND[h] ||= []).push(s.key);

function emptyStats(uid) {
  const counts = {};
  for (const s of ALL_SETS) counts[s.key] = 0;
  return {
    uid,
    n: 0, // ターン数（スキップ除く）
    skips: 0,
    proxied: 0,
    counts,
    hands: {},
    rolls: 0,
    firstRoll: 0,
    faces: [0, 0, 0, 0, 0, 0],
    rounds: 0,
    top: 0,
    bottom: 0,
    winScore: 0,
    seq: [],
    streak: { yaku: 0, bad: 0, menashi: 0 },
    pairs: 0,
    samePairs: 0,
    after: {}, // 前回カテゴリ → { prev, again }
  };
}

function addRecord(st, r) {
  if (r.h === 'skip') { st.skips++; return; }
  st.n++;
  if (r.by) st.proxied++;
  st.hands[r.h] = (st.hands[r.h] || 0) + 1;
  for (const k of SET_OF_HAND[r.h] || []) st.counts[k]++;
  st.rolls += r.rolls.length;
  if (r.rolls.length === 1) st.firstRoll++;
  for (const roll of r.rolls) for (const d of roll) st.faces[d - 1]++;
  if (r.rank != null && r.size >= 2) {
    st.rounds++;
    if (r.top) st.top++;
    if (r.bottom) st.bottom++;
    st.winScore += (r.size - r.rank) / (r.size - 1);
  }
  st.seq.push(r.h);
}

function maxRun(seq, test) {
  let best = 0;
  let cur = 0;
  for (const h of seq) { cur = test(h) ? cur + 1 : 0; if (cur > best) best = cur; }
  return best;
}

function finishStats(st) {
  const yaku = new Set(GROUPS.find((g) => g.key === 'yaku').hands);
  const bad = new Set(GROUPS.find((g) => g.key === 'bad').hands);
  st.streak.yaku = maxRun(st.seq, (h) => yaku.has(h));
  st.streak.bad = maxRun(st.seq, (h) => bad.has(h));
  st.streak.menashi = maxRun(st.seq, (h) => h === 'menashi');
  for (let i = 1; i < st.seq.length; i++) {
    const prev = st.seq[i - 1];
    const cur = st.seq[i];
    st.pairs++;
    if (prev === cur) st.samePairs++;
    const pc = categoryOf(prev);
    const a = (st.after[pc] ||= { prev: 0, again: 0 });
    a.prev++;
    if (categoryOf(cur) === pc) a.again++;
  }
  return st;
}

/** 記録一覧から個人別・全体の集計を作る */
export function analyze(records) {
  const byUser = new Map();
  const total = emptyStats('*');
  for (const r of records) {
    if (!byUser.has(r.u)) byUser.set(r.u, emptyStats(r.u));
    addRecord(byUser.get(r.u), r);
    addRecord(total, r);
  }
  for (const st of byUser.values()) finishStats(st);
  // 全体の連続系は個人ごとの合計にする（別人どうしの並びは連続とみなさない）
  total.seq = [];
  for (const st of byUser.values()) {
    total.pairs += st.pairs;
    total.samePairs += st.samePairs;
    for (const [k, v] of Object.entries(st.after)) {
      const a = (total.after[k] ||= { prev: 0, again: 0 });
      a.prev += v.prev;
      a.again += v.again;
    }
    for (const k of Object.keys(total.streak)) total.streak[k] = Math.max(total.streak[k], st.streak[k]);
  }
  return { total, users: [...byUser.values()], rounds: roundsOf(records) };
}

/** 周ごとにまとめる（新しい周が先頭） */
export function roundsOf(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.r)) map.set(r.r, []);
    map.get(r.r).push(r);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([round, recs]) => ({ round, records: recs, at: recs.at(-1).t }));
}

// ---------- 統計ヘルパー ----------
export const rate = (num, den) => (den > 0 ? num / den : null);

/** 二項検定のz値（観測が理論よりどれだけ多い/少ないか） */
export function zScore(k, n, p) {
  if (!n || p <= 0 || p >= 1) return 0;
  return (k - n * p) / Math.sqrt(n * p * (1 - p));
}

function lowerGammaRegularized(s, x) {
  if (x <= 0) return 0;
  let sum = 1 / s;
  let term = 1 / s;
  for (let k = 1; k < 200; k++) {
    term *= x / (s + k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return Math.exp(-x + s * Math.log(x) - logGamma(s)) * sum;
}

function logGamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** サイコロの目（1〜6）の偏りをカイ二乗検定。p値が小さいほど偏っている */
export function faceBias(faces) {
  const n = faces.reduce((a, b) => a + b, 0);
  if (n < 30) return { n, chi2: null, p: null };
  const e = n / 6;
  const chi2 = faces.reduce((s, o) => s + (o - e) ** 2 / e, 0);
  return { n, chi2, p: 1 - lowerGammaRegularized(2.5, chi2 / 2) };
}

/** 理論値に対する偏りの言葉 */
export function biasWord(z) {
  const a = Math.abs(z);
  if (a < 1.28) return null;
  const dir = z > 0 ? '多い' : '少ない';
  if (a >= 2.58) return `かなり${dir}`;
  if (a >= 1.96) return dir;
  return `やや${dir}`;
}

// ---------- 指標（ランキングの切り口） ----------
const theoryOf = (hands) => (settings) => theoreticalFor(hands, settings?.shonben ? settings.shonbenRate : 0);

export function buildMetrics(settings, hasShonben) {
  const showShonben = settings?.shonben || hasShonben;
  const handMetrics = ALL_SETS.filter((s) => !s.optional || showShonben).map((s) => ({
    key: `hand:${s.key}`,
    section: CATEGORIES.includes(s) ? '役の出やすさ' : '役のまとまり',
    label: s.label,
    unit: 'pct',
    theory: theoryOf(s.hands)(settings),
    get: (st) => ({ value: rate(st.counts[s.key], st.n), num: st.counts[s.key], den: st.n }),
  }));
  const pct = (section, key, label, get, theory) => ({ key, section, label, unit: 'pct', theory, get });
  const num = (section, key, label, get, digits = 0) => ({ key, section, label, unit: 'num', digits, get });
  return [
    ...handMetrics,
    pct('勝ち負け', 'top', '最強率（周でトップ）', (st) => ({ value: rate(st.top, st.rounds), num: st.top, den: st.rounds })),
    pct('勝ち負け', 'bottom', '最弱率（周でビリ）', (st) => ({ value: rate(st.bottom, st.rounds), num: st.bottom, den: st.rounds })),
    pct('勝ち負け', 'winScore', '勝ちっぷり（平均順位スコア）', (st) => ({ value: rate(st.winScore, st.rounds), num: null, den: st.rounds })),
    pct('振り方', 'firstRoll', '1投目で決まった率', (st) => ({ value: rate(st.firstRoll, st.n), num: st.firstRoll, den: st.n }), theoreticalFirstRoll(settings?.shonben ? settings.shonbenRate : 0)),
    num('振り方', 'avgRolls', '平均投数', (st) => ({ value: rate(st.rolls, st.n), num: st.rolls, den: st.n }), 2),
    pct('連続', 'again:hifumi', 'ヒフミの次もヒフミ', againGet('hifumi'), theoryOf(['hifumi'])(settings)),
    pct('連続', 'again:shigoro', 'シゴロの次もシゴロ', againGet('shigoro'), theoryOf(['shigoro'])(settings)),
    pct('連続', 'again:menashi', '目なしの次も目なし', againGet('menashi'), theoryOf(['menashi'])(settings)),
    pct('連続', 'same', '同じ役が2回連続した率', (st) => ({ value: rate(st.samePairs, st.pairs), num: st.samePairs, den: st.pairs })),
    num('連続', 'streak:yaku', '最長 役あり連続', (st) => ({ value: st.n ? st.streak.yaku : null, num: null, den: st.n })),
    num('連続', 'streak:bad', '最長 ハズレ連続', (st) => ({ value: st.n ? st.streak.bad : null, num: null, den: st.n })),
    ...[1, 2, 3, 4, 5, 6].map((f) => pct('サイコロの目', `face:${f}`, `「${f}」が出た率`, (st) => {
      const n = st.faces.reduce((a, b) => a + b, 0);
      return { value: rate(st.faces[f - 1], n), num: st.faces[f - 1], den: n };
    }, 1 / 6)),
    num('その他', 'turns', 'ターン数', (st) => ({ value: st.n, num: null, den: st.n })),
    num('その他', 'skips', 'スキップ回数', (st) => ({ value: st.skips, num: null, den: st.n + st.skips })),
  ];
}

function againGet(cat) {
  return (st) => {
    const a = st.after[cat] || { prev: 0, again: 0 };
    return { value: rate(a.again, a.prev), num: a.again, den: a.prev };
  };
}

/** 指標でメンバーを並べる。サンプルが少ない人は後ろへ。 */
export function rankBy(metric, users) {
  const rows = users.map((st) => ({ uid: st.uid, st, ...metric.get(st) }));
  const minDen = metric.unit === 'pct' ? MIN_SAMPLE : 1;
  const enough = rows.filter((r) => r.value != null && r.den >= minDen).sort((a, b) => b.value - a.value || b.den - a.den);
  const few = rows.filter((r) => !(r.value != null && r.den >= minDen)).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  let rank = 0;
  let prev = null;
  enough.forEach((r, i) => {
    if (r.value !== prev) { rank = i + 1; prev = r.value; }
    r.rank = rank;
  });
  return { rows: enough, few };
}

// ---------- 対戦成績 ----------
export function headToHead(records) {
  const out = {}; // out[a][b] = { w, l, d }
  for (const { records: recs } of roundsOf(records)) {
    const played = recs.filter((r) => r.h !== 'skip' && r.rank != null);
    for (const a of played) for (const b of played) {
      if (a.u === b.u) continue;
      const rec = ((out[a.u] ||= {})[b.u] ||= { w: 0, l: 0, d: 0 });
      const d = strengthOf(a.h) - strengthOf(b.h);
      if (d > 0) rec.w++; else if (d < 0) rec.l++; else rec.d++;
    }
  }
  return out;
}

// ---------- 注目ポイント ----------
/** 概要に出す「話のネタ」を作る。nameOf(uid) で名前を引く。 */
export function insights(result, settings, nameOf) {
  const out = [];
  const enough = result.users.filter((u) => u.n >= MIN_SAMPLE);
  const sr = settings?.shonben ? settings.shonbenRate : 0;
  const crown = (key, label, hands, emoji) => {
    const p = theoreticalFor(hands, sr);
    const best = enough.map((u) => ({ u, v: u.counts[key] / u.n })).filter((x) => x.u.counts[key] > 0).sort((a, b) => b.v - a.v)[0];
    if (!best) return;
    const ratio = best.v / p;
    out.push({ emoji, title: `${label}がいちばん多い`, who: best.u.uid, text: `${pctText(best.v)}（${best.u.counts[key]}回）・理論値の${ratio.toFixed(1)}倍`, score: ratio });
  };
  crown('arashi', 'アラシ', CATEGORIES[1].hands, '⚡');
  crown('shigoro', 'シゴロ', ['shigoro'], '✨');
  crown('hifumi', 'ヒフミ', ['hifumi'], '💀');
  crown('menashi', '目なし', ['menashi'], '🌀');

  for (const u of result.users) {
    if (u.hands.pinzoro) out.push({ emoji: '🎯', title: 'ピンゾロ達成', who: u.uid, text: `${u.hands.pinzoro}回（理論上は約123回に1回）`, score: 10 + u.hands.pinzoro });
    const hh = u.after.hifumi?.again || 0;
    if (hh) out.push({ emoji: '☠️', title: 'ヒフミ2連続', who: u.uid, text: `${hh}回（偶然なら約0.24%）`, score: 8 + hh });
  }
  const topper = enough.filter((u) => u.rounds >= MIN_SAMPLE).sort((a, b) => b.top / b.rounds - a.top / a.rounds)[0];
  if (topper && topper.top) out.push({ emoji: '👑', title: '最強の回数が多い', who: topper.uid, text: `${topper.rounds}周中${topper.top}回トップ（${pctText(topper.top / topper.rounds)}）`, score: 3 });
  const loser = enough.filter((u) => u.rounds >= MIN_SAMPLE).sort((a, b) => b.bottom / b.rounds - a.bottom / a.rounds)[0];
  if (loser && loser.bottom) out.push({ emoji: '🍺', title: '最弱の回数が多い', who: loser.uid, text: `${loser.rounds}周中${loser.bottom}回ビリ（${pctText(loser.bottom / loser.rounds)}）`, score: 3 });
  const streaky = [...result.users].sort((a, b) => b.streak.bad - a.streak.bad)[0];
  if (streaky && streaky.streak.bad >= 3) out.push({ emoji: '🥶', title: '最長ハズレ連続', who: streaky.uid, text: `${streaky.streak.bad}連続で目なし・ヒフミ・ションベン`, score: streaky.streak.bad });
  const hot = [...result.users].sort((a, b) => b.streak.yaku - a.streak.yaku)[0];
  if (hot && hot.streak.yaku >= 4) out.push({ emoji: '🔥', title: '最長 役あり連続', who: hot.uid, text: `${hot.streak.yaku}連続で役あり`, score: hot.streak.yaku / 2 });
  const biased = result.users.map((u) => ({ u, b: faceBias(u.faces) })).filter((x) => x.b.p != null && x.b.p < 0.05).sort((a, b) => a.b.p - b.b.p)[0];
  if (biased) {
    const f = biased.u.faces;
    const most = f.indexOf(Math.max(...f)) + 1;
    out.push({ emoji: '🎲', title: 'サイコロの目に偏り', who: biased.u.uid, text: `「${most}」が出やすい（偶然この偏りになる確率 ${pctText(biased.b.p)}）`, score: 4 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8).map((x) => ({ ...x, name: nameOf(x.who) }));
}

export function pctText(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export { HANDS, CATEGORIES, GROUPS };
