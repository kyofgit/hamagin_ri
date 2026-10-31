// チンチロのルール定義（サーバーとブラウザの両方で使う共有モジュール）

export const MAX_ROLLS = 3;
export const MAX_RECORDS = 1000;

// 役の一覧。strength が大きいほど強い。
export const HANDS = {
  pinzoro: { label: 'ピンゾロ', strength: 100 },
  arashi6: { label: 'アラシ', detail: '6', strength: 96 },
  arashi5: { label: 'アラシ', detail: '5', strength: 95 },
  arashi4: { label: 'アラシ', detail: '4', strength: 94 },
  arashi3: { label: 'アラシ', detail: '3', strength: 93 },
  arashi2: { label: 'アラシ', detail: '2', strength: 92 },
  shigoro: { label: 'シゴロ', strength: 80 },
  me6: { label: '6の目', strength: 66 },
  me5: { label: '5の目', strength: 65 },
  me4: { label: '4の目', strength: 64 },
  me3: { label: '3の目', strength: 63 },
  me2: { label: '2の目', strength: 62 },
  me1: { label: '1の目', strength: 61 },
  menashi: { label: '目なし', strength: 20 },
  shonben: { label: 'ションベン', strength: 15 },
  hifumi: { label: 'ヒフミ', strength: 0 },
};

// 分析で使う「役のまとまり」。hands に含まれる役を1つにまとめて数える。
export const CATEGORIES = [
  { key: 'pinzoro', label: 'ピンゾロ', hands: ['pinzoro'] },
  { key: 'arashi', label: 'アラシ', hands: ['arashi2', 'arashi3', 'arashi4', 'arashi5', 'arashi6'] },
  { key: 'shigoro', label: 'シゴロ', hands: ['shigoro'] },
  { key: 'me6', label: '6の目', hands: ['me6'] },
  { key: 'me5', label: '5の目', hands: ['me5'] },
  { key: 'me4', label: '4の目', hands: ['me4'] },
  { key: 'me3', label: '3の目', hands: ['me3'] },
  { key: 'me2', label: '2の目', hands: ['me2'] },
  { key: 'me1', label: '1の目', hands: ['me1'] },
  { key: 'menashi', label: '目なし', hands: ['menashi'] },
  { key: 'hifumi', label: 'ヒフミ', hands: ['hifumi'] },
  { key: 'shonben', label: 'ションベン', hands: ['shonben'], optional: true },
];

// 複数カテゴリをまたぐ集計（ランキング等で使う）
export const GROUPS = [
  { key: 'zoro', label: 'ゾロ目（ピンゾロ＋アラシ）', hands: ['pinzoro', 'arashi2', 'arashi3', 'arashi4', 'arashi5', 'arashi6'] },
  { key: 'strong', label: 'シゴロ以上', hands: ['pinzoro', 'arashi2', 'arashi3', 'arashi4', 'arashi5', 'arashi6', 'shigoro'] },
  { key: 'me', label: '目あり（1〜6の目）', hands: ['me1', 'me2', 'me3', 'me4', 'me5', 'me6'] },
  { key: 'yaku', label: '役あり（1の目以上）', hands: ['pinzoro', 'arashi2', 'arashi3', 'arashi4', 'arashi5', 'arashi6', 'shigoro', 'me1', 'me2', 'me3', 'me4', 'me5', 'me6'] },
  { key: 'bad', label: 'ハズレ（目なし・ヒフミ・ションベン）', hands: ['menashi', 'hifumi', 'shonben'] },
];

const HAND_TO_CATEGORY = {};
for (const c of CATEGORIES) for (const h of c.hands) HAND_TO_CATEGORY[h] = c.key;
export const categoryOf = (hand) => HAND_TO_CATEGORY[hand];

/** 3つのサイコロから役を判定する。役がなければ null（振り直し）。 */
export function evaluate(dice) {
  const [a, b, c] = [...dice].sort((x, y) => x - y);
  if (a === b && b === c) return a === 1 ? 'pinzoro' : `arashi${a}`;
  if (a === 4 && b === 5 && c === 6) return 'shigoro';
  if (a === 1 && b === 2 && c === 3) return 'hifumi';
  if (a === b) return `me${c}`;
  if (b === c) return `me${a}`;
  return null;
}

/** 1回の振りが最終結果になるか */
export const isDecisive = (hand) => hand !== null;

export const strengthOf = (hand) => HANDS[hand]?.strength ?? -1;

export function handLabel(hand) {
  const h = HANDS[hand];
  if (!h) return hand === 'skip' ? 'スキップ' : '';
  return h.detail ? `${h.label} ${h.detail}` : h.label;
}

/**
 * 1ターン（最大3投）の最終結果の理論確率。
 * shonbenRate: 1投ごとにションベン（どんぶりから出る）になる確率。0ならションベンなし。
 */
export function theoreticalHandProbs(shonbenRate = 0) {
  const single = {};
  let nullP = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) {
    const h = evaluate([a, b, c]);
    if (h) single[h] = (single[h] || 0) + 1 / 216;
    else nullP += 1 / 216;
  }
  const s = shonbenRate;
  const cont = (1 - s) * nullP; // 振り直しになる確率
  let reach = 0; // 1投目〜3投目に到達する確率の合計
  for (let k = 0; k < MAX_ROLLS; k++) reach += cont ** k;
  const out = {};
  for (const h of Object.keys(HANDS)) out[h] = 0;
  for (const [h, p] of Object.entries(single)) out[h] = reach * (1 - s) * p;
  out.shonben = reach * s;
  out.menashi = cont ** MAX_ROLLS;
  return out;
}

export function theoreticalFor(hands, shonbenRate = 0) {
  const p = theoreticalHandProbs(shonbenRate);
  return hands.reduce((sum, h) => sum + (p[h] || 0), 0);
}

/** 1投目で決着する理論確率 */
export function theoreticalFirstRoll(shonbenRate = 0) {
  return shonbenRate + (1 - shonbenRate) * 0.5;
}
