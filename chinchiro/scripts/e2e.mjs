// ブラウザでの通しテスト（Firebaseエミュレータ使用）
// 3人でGoogleログイン（模擬）→ルーム参加→プレイ（代理振り・スキップ・休憩）→周の結果→記録・分析→再読み込み後も保持→外す
// 使い方: FIREBASE_BIN=<firebaseコマンド> npm run e2e   （SHOTS=ディレクトリ でスクリーンショット保存）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const SDK = path.join(ROOT, 'node_modules', 'firebase');
const FIREBASE = process.env.FIREBASE_BIN || 'firebase';
const PORT = 5055;
const BASE = `http://localhost:${PORT}/?emu=1`;
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
let step = '';
let emu;
let web;
const assert = (c, m) => { if (!c) throw new Error(`[${step}] ${m}`); };
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${n}.png`) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startEmulators() {
  return new Promise((resolve, reject) => {
    emu = spawn(FIREBASE, ['emulators:start', '--only', 'auth,firestore', '--project', 'demo-chinchiro'], { cwd: ROOT, env: process.env });
    let out = '';
    const onData = (d) => { out += d; if (out.includes('All emulators ready')) resolve(); };
    emu.stdout.on('data', onData);
    emu.stderr.on('data', onData);
    emu.on('exit', (c) => reject(new Error(`emulators exited ${c}\n${out.slice(-2000)}`)));
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function startWeb() {
  web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(PUB, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => web.listen(PORT, r));
}

async function newUser(browser, sub, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  // Firebase SDK は gstatic の代わりに npm 版を配信（この環境から gstatic に届かないため）
  await ctx.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const file = path.join(SDK, path.basename(new URL(route.request().url()).pathname));
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
  });
  await ctx.route('https://cdnjs.cloudflare.com/**', (route) => route.fulfill({ status: 404, body: '' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|ERR_/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.uname = name;
  page.sub = sub;
  return page;
}

async function login(page, url = BASE) {
  await page.goto(url);
  await page.waitForSelector('#login:not([hidden])');
  await page.evaluate(([s, n]) => window.__cc.login(s, n), [page.sub, page.uname]);
  await page.waitForSelector('#room:not([hidden]) .lu');
}

const turnName = (p) => p.locator('#turn .t-name').textContent();
const closeResults = async (pages) => {
  for (const p of pages) {
    if (await p.locator('#result:not([hidden])').count()) { await p.click('#result [data-act=closeResult]'); await sleep(150); }
  }
};

/** 手番の人のページで、ターンが終わるまで振る（proxyBy を渡すとその人が代理で振る） */
async function playTurn(pages, proxyBy) {
  let owner = null;
  for (let t = 0; t < 30 && !owner; t++) {
    for (const p of pages) if (await p.locator('#controls [data-act=roll]').count()) owner = p;
    if (!owner) await sleep(200);
  }
  assert(owner, '手番の人が見つかりません');
  const actor = proxyBy || owner;
  for (let i = 0; i < 3; i++) {
    await actor.waitForFunction(() => !window.__cc.state().rolling && !window.__cc.state().busy, null, { timeout: 8000 });
    if ((await turnName(actor)) !== owner.uname) break;
    if (proxyBy) { await actor.click('#controls [data-act=proxy]'); await actor.click('#askOk'); }
    else await actor.click('#controls [data-act=roll]');
    await actor.waitForFunction(() => !window.__cc.state().rolling && !window.__cc.state().busy, null, { timeout: 8000 });
    await sleep(300);
  }
  return owner.uname;
}

async function main() {
  await Promise.all([startEmulators(), startWeb()]);
  const browser = await chromium.launch();
  try {
    step = 'login';
    const A = await newUser(browser, 'taro', 'たろう');
    const B = await newUser(browser, 'hana', 'はなこ');
    const C = await newUser(browser, 'jiro', 'じろう');
    await A.goto(BASE);
    await A.waitForSelector('#login:not([hidden])');
    await sleep(800);
    await shot(A, '01-login');
    await A.evaluate(() => window.__cc.login('taro', 'たろう'));
    await A.waitForSelector('#room:not([hidden]) .lu');
    const roomId = new URL(A.url()).searchParams.get('r');
    assert(/^[a-z0-9]{10}$/.test(roomId), `ルームIDが不正: ${roomId}`);

    step = 'join';
    const url = `http://localhost:${PORT}/?r=${roomId}&emu=1`;
    await login(B, url);
    await login(C, url);
    await A.waitForFunction(() => document.querySelectorAll('#lineup .lu').length === 3, null, { timeout: 10000 });
    assert((await turnName(A)) === 'たろう', '最初の手番がたろうでない');
    await shot(A, '02-play-myturn');

    step = 'round1';
    const pages = [A, B, C];
    await playTurn(pages);
    await shot(B, '03-play-after-roll');
    await playTurn(pages);
    await playTurn(pages, A); // じろうの番を たろう が代理で振る
    for (const p of pages) await p.waitForSelector('#result:not([hidden])', { timeout: 8000 });
    await shot(A, '04-round-result');
    assert(await A.locator('.r-list li').count() === 3, '周の結果が3人分でない');
    await closeResults(pages);

    step = 'round2-skip';
    await playTurn(pages);
    await A.click('#controls [data-act=skip]');
    await A.click('#askOk');
    await C.waitForFunction(() => document.querySelector('#turn .t-name')?.textContent === 'じろう', null, { timeout: 8000 });
    await playTurn(pages);
    for (const p of pages) await p.waitForSelector('#result:not([hidden])', { timeout: 8000 });
    assert(await A.locator('.r-list li.skip').count() === 1, 'スキップが結果に出ていない');
    await closeResults(pages);

    step = 'away';
    await A.click('[data-open=settings]');
    await A.waitForSelector('.mrow');
    await shot(A, '09-settings-members');
    const cUid = await C.evaluate(() => window.__cc.state().user.uid);
    await A.locator(`.mrow[data-id="${cUid}"] [data-f=away]`).check();
    await A.waitForFunction(() => document.querySelectorAll('#prog i').length === 2, null, { timeout: 8000 });
    await A.locator(`.mrow[data-id="${cUid}"] [data-f=away]`).uncheck();
    await A.waitForFunction(() => document.querySelectorAll('#prog i').length === 3, null, { timeout: 8000 });
    await A.click('.tabs [data-tab=rules]');
    await shot(A, '10-settings-rules');

    step = 'back-button';
    await A.goBack();
    await sleep(400);
    assert(!(await A.evaluate(() => document.querySelector('#sheet').open)), '戻る操作でシートが閉じない');
    assert(await A.locator('#room:not([hidden])').count() === 1, '戻る操作でルーム画面から離れた');

    step = 'fill-history';
    for (let n = 0; n < 60; n++) {
      for (const p of pages) await p.evaluate(() => window.__cc.rollNow());
    }
    await sleep(2500);
    await closeResults(pages);

    step = 'history';
    await A.click('[data-open=history]');
    await A.waitForSelector('.hround');
    await shot(A, '06-history');
    await A.locator('[data-log]').nth(2).click();
    await A.waitForSelector('.h-rno');
    await shot(A, '06b-history-member');
    await A.click('.s-head [data-act=close]');

    step = 'stats';
    await A.click('[data-open=stats]');
    await A.waitForSelector('.s-body.stats');
    for (const k of ['today', 'yesterday', 'last100', 'last10rounds', 'thisWeek', 'lastWeek', 'thisMonth', 'custom', 'all']) await A.click(`[data-period=${k}]`);
    await A.waitForSelector('.ins');
    await shot(A, '07-stats-overview');
    await A.click('[data-view=person]');
    await A.waitForSelector('.phead');
    await shot(A, '08-stats-person');
    await A.click('[data-view=ranking]');
    await A.waitForSelector('.rank li');
    await shot(A, '11-stats-ranking');
    const opts = await A.locator('[data-metric-select] option').evaluateAll((os) => os.map((o) => o.value));
    for (const v of opts) await A.selectOption('[data-metric-select]', v);
    await A.click('[data-view=h2h]');
    await A.waitForSelector('.mx');
    await shot(A, '12-stats-h2h');
    await A.click('.s-head [data-act=close]');
    await A.click('[data-open=share]');
    await A.waitForSelector('.url');
    await A.click('.s-head [data-act=close]');
    await shot(A, '05-play-later');

    step = 'persist';
    const before = await A.evaluate(() => window.__cc.state().records.length);
    await A.reload();
    await A.waitForSelector('#room:not([hidden]) .lu');
    await A.waitForFunction((n) => window.__cc.state().records.length === n, before, { timeout: 10000 });

    step = 'kick';
    await A.click('[data-open=settings]');
    await A.locator(`.mrow[data-id="${cUid}"] [data-act=kick]`).click();
    await A.click('#askOk');
    await C.waitForSelector('#msg:not([hidden])', { timeout: 8000 });
    assert((await C.textContent('#msgTitle')) === 'ルームから外れました', '外されたメンバーに通知が出ない');

    assert(errors.length === 0, `ブラウザでエラー:\n${errors.join('\n')}`);
    console.log(`OK: 全ステップ成功（記録 ${before} 件・再読み込み後も保持）`);
  } catch (e) {
    if (SHOTS) for (const [i, ctx] of browser.contexts().entries()) for (const pg of ctx.pages()) await pg.screenshot({ path: path.join(SHOTS, `fail-${i}.png`) }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    web.close();
    emu.kill('SIGINT');
  }
}

main().catch((e) => { console.error(`NG [${step}]:`, e.message); if (errors.length) console.error(errors.join('\n')); emu?.kill('SIGINT'); process.exit(1); });
