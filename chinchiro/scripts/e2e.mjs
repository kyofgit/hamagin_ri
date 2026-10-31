// ブラウザでの通しテスト（3人でログイン→グループ参加→プレイ→分析→再起動後のデータ保持）
// 使い方: npm run e2e  （SHOTS=ディレクトリ を指定するとスクリーンショットを保存）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'chinchiro-e2e-'));
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
let server;
let step = '';

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA } });
    server.stdout.on('data', (d) => { if (String(d).includes('起動')) resolve(); });
    server.stderr.on('data', (d) => process.stderr.write(d));
    server.on('exit', (c) => c && reject(new Error(`server exited ${c}`)));
  });
}
const stopServer = () => new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
const assert = (cond, msg) => { if (!cond) throw new Error(`[${step}] ${msg}`); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

async function newUser(browser, loginId, name, { dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.uname = name;
  return page;
}

async function register(page, loginId, name, url = BASE) {
  await page.goto(url);
  await page.click('[data-mode=register]');
  await page.fill('input[name=loginId]', loginId);
  await page.fill('input[name=name]', name);
  await page.fill('input[name=password]', 'pass1234');
  await page.click('button[type=submit]');
}

const closeSheets = async (pages) => {
  for (const p of pages) {
    const btn = p.locator('.sheet [data-close].btn.primary, .rr [data-close]');
    if (await btn.count()) { await btn.first().click(); await p.waitForTimeout(300); }
  }
};

/** 手番の人のページを探して、その人のターンが終わるまで振る */
async function playTurn(pages, { proxyBy = null } = {}) {
  const owner = await findTurnPage(pages);
  assert(owner, '手番の人が見つかりません');
  const actor = proxyBy || owner;
  const name = owner.uname;
  for (let i = 0; i < 3; i++) {
    const cur = await actor.locator('.turn-name').first().textContent();
    if (cur !== name) break;
    if (proxyBy) {
      await actor.click('[data-act=proxy]');
      await actor.click('.sheet [data-ok]');
    } else {
      await actor.click('[data-act=roll]');
    }
    await actor.waitForTimeout(2400);
  }
  return name;
}

async function findTurnPage(pages) {
  for (let t = 0; t < 20; t++) {
    for (const p of pages) if (await p.locator('[data-act=roll]').count()) return p;
    await pages[0].waitForTimeout(200);
  }
  return null;
}

async function fillHistory(pages, gid, rounds) {
  // API経由で大量に振って分析画面用のデータを作る
  for (let n = 0; n < rounds * pages.length * 3; n++) {
    const { group } = await (await pages[0].request.get(`${BASE}/api/groups/${gid}`)).json();
    const uid = group.game.turn?.uid;
    if (!uid) break;
    const who = group.members.find((m) => m.uid === uid).name;
    const p = pages.find((x) => x.uname === who);
    const res = await p.request.post(`${BASE}/api/groups/${gid}/roll`, { data: { key: group.game.key } });
    assert(res.ok(), `API roll failed ${res.status()}`);
  }
}

async function main() {
  await startServer();
  const browser = await chromium.launch();
  try {
    step = 'register';
    const A = await newUser(browser, 'taro', 'たろう');
    const B = await newUser(browser, 'hana', 'はなこ');
    const C = await newUser(browser, 'jiro', 'じろう', { dark: true });
    await A.goto(BASE);
    await A.waitForSelector('.auth');
    await shot(A, '01-login');
    await register(A, 'taro', 'たろう');
    await A.waitForSelector('.page-title');
    assert((await A.textContent('.page-title')) === 'グループ', 'ホームが表示されない');

    step = 'create-group';
    await A.click('[data-act=create]');
    await A.fill('.sheet input', '金曜の飲み会');
    await A.click('.sheet button[type=submit]');
    await A.waitForSelector('.invite-code');
    const code = (await A.textContent('.invite-code')).trim();
    assert(/^[A-Z0-9]{6}$/.test(code), `招待コードが不正: ${code}`);
    const gid = A.url().match(/#\/g\/([^/]+)/)[1];

    step = 'join';
    await register(B, 'hana', 'はなこ');
    await B.waitForSelector('[data-act=join]');
    await B.click('[data-act=join]');
    await B.fill('.sheet input', code.toLowerCase());
    await B.click('.sheet button[type=submit]');
    await B.waitForSelector('.bowl');
    await register(C, 'jiro', 'じろう', `${BASE}/#/join/${code}`);
    await C.waitForSelector('.bowl');
    await A.waitForFunction(() => document.querySelectorAll('.member-row').length === 3);
    await shot(A, '09-members');

    step = 'round1';
    await A.click('[data-tab=play]');
    await A.waitForSelector('.bowl');
    const pages = [A, B, C];
    assert((await A.textContent('.turn-name')) === 'たろう', '最初の手番がたろうでない');
    await shot(A, '02-play-myturn');
    await playTurn(pages);
    await shot(B, '03-play-after-roll');
    await playTurn(pages);
    await playTurn(pages, { proxyBy: A }); // じろうの番を たろう が代理で振る
    for (const p of pages) await p.waitForSelector('.rr', { timeout: 5000 });
    await shot(A, '04-round-result');
    const rows = await A.locator('.rr-row').count();
    assert(rows === 3, `周の結果が3人分でない: ${rows}`);
    await closeSheets(pages);

    step = 'round2-skip';
    await playTurn(pages);
    await A.click('[data-act=skip]'); // はなこを今回だけスキップ
    await A.click('.sheet [data-ok]');
    await A.waitForTimeout(800);
    assert((await C.textContent('.turn-name')) === 'じろう', 'スキップ後にじろうの番にならない');
    await shot(C, '05-play-dark-myturn');
    await playTurn(pages);
    for (const p of pages) await p.waitForSelector('.rr', { timeout: 5000 });
    assert(await A.locator('.rr-row.skip').count() === 1, 'スキップが結果に出ていない');
    await closeSheets(pages);

    step = 'away';
    await A.click('[data-tab=members]');
    await A.waitForSelector('.member-row');
    await A.locator('[data-away]').nth(2).check(); // じろうを休憩に
    await A.waitForTimeout(500);
    await A.click('[data-tab=play]');
    await A.waitForSelector('.board-row');
    const lineup = await A.locator('.round-progress i').count();
    assert(lineup === 2, `休憩中の人が並びから外れていない: ${lineup}`);
    await A.click('[data-tab=members]');
    await A.locator('[data-away]').nth(2).uncheck();
    await A.waitForTimeout(400);

    step = 'fill-history';
    await fillHistory(pages, gid, 40);
    await A.click('[data-tab=log]');
    await A.waitForSelector('.log-round');
    await shot(A, '06-log');
    await A.locator('[data-log-member]').nth(2).click(); // はなこだけ表示
    await A.waitForSelector('.log-flat .log-row');
    assert(await A.locator('.log-rno').count() > 0, 'メンバー別の記録が出ない');
    await shot(A, '06b-log-member');

    step = 'stats';
    await A.click('[data-tab=stats]');
    await A.waitForSelector('.stats-body');
    for (const key of ['today', 'yesterday', 'last100', 'last10rounds', 'thisWeek', 'lastWeek', 'thisMonth', 'custom', 'all']) {
      await A.click(`[data-period=${key}]`);
    }
    await A.click('[data-period=all]');
    await A.waitForSelector('.insight');
    await shot(A, '07-stats-overview');
    await A.screenshot({ path: SHOTS ? path.join(SHOTS, '07b-stats-overview-full.png') : path.join(DATA, 'x.png'), fullPage: true });
    await A.click('[data-view=person]');
    await A.waitForSelector('.person-head');
    await A.screenshot({ path: SHOTS ? path.join(SHOTS, '08-stats-person-full.png') : path.join(DATA, 'y.png'), fullPage: true });
    await A.click('[data-view=ranking]');
    await A.waitForSelector('.rank-row');
    await shot(A, '10-stats-ranking');
    const opts = await A.locator('[data-metric-select] option').evaluateAll((os) => os.map((o) => o.value));
    for (const v of opts) await A.selectOption('[data-metric-select]', v);
    await A.click('[data-view=h2h]');
    await A.waitForSelector('.matrix');
    await shot(A, '11-stats-h2h');
    await C.click('[data-tab=stats]');
    await C.click('[data-period=all]');
    await C.click('[data-view=ranking]');
    await C.waitForSelector('.rank-row');
    await shot(C, '12-stats-ranking-dark');
    await A.click('[data-tab=play]');
    await A.waitForSelector('.bowl');
    await A.goto(`${BASE}/#/`);
    await A.waitForSelector('.group-item');
    await shot(A, '00-home');

    step = 'persist';
    const before = (await (await A.request.get(`${BASE}/api/groups/${gid}`)).json()).records.length;
    await stopServer();
    await startServer();
    const after = (await (await A.request.get(`${BASE}/api/groups/${gid}`)).json()).records.length;
    assert(before > 0 && before === after, `再起動後に記録が変わった: ${before} → ${after}`);

    assert(errors.length === 0, `ブラウザでエラー:\n${errors.join('\n')}`);
    console.log(`OK: 全ステップ成功（記録 ${after} 件・再起動後も保持）`);
  } catch (e) {
    if (SHOTS) for (const [i, ctx] of browser.contexts().entries()) for (const pg of ctx.pages()) await pg.screenshot({ path: path.join(SHOTS, `fail-${i}.png`) }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await stopServer().catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(`NG [${step}]:`, e.message); if (errors.length) console.error(errors.join('\n')); server?.kill(); process.exit(1); });
