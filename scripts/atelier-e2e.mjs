/**
 * E2E check: Atelier (agent-native design studio) wired into the real app.
 * Uses the locally installed Chrome with the WebMCP feature flag against the dev server.
 *
 * Usage: node scripts/atelier-e2e.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5173/?clean=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-features=WebMCP', '--no-first-run', '--disable-extensions', '--user-data-dir=/tmp/atelier-chrome-profile'],
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle2' });
await sleep(800);

const badge = await page.$eval('#webmcp-status', (el) => el.textContent);
console.log(`badge: ${badge}`);

// 1. Agent-side discovery includes the Atelier tools
const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name));
console.log(`tools (${tools.length}): ${tools.join(', ')}`);
for (const t of ['list_templates', 'get_current_design', 'filter_templates', 'get_vendor_content', 'edit_flyer', 'apply_template', 'create_variant', 'order_prints', 'order_prints_form']) {
  if (!tools.includes(t)) throw new Error(`missing tool: ${t}`);
}

// 2. Agent proposes an edit → ghost preview appears, real flyer UNCHANGED
await page.evaluate(() => {
  window.__guard.dispatch('edit_flyer', { title: 'Ghost Title', color: '#224466' });
});
await page.waitForSelector('.tx-card .tx-chip', { timeout: 3000 });
let chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const ghostVisible = await page.$eval('#flyer-ghost', (el) => !el.classList.contains('hidden'));
const ghostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
let realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`staged: chip=${chip}, ghost visible=${ghostVisible} ("${ghostTitle}"), real flyer title="${realTitle}"`);
if (chip !== 'proposed' || !ghostVisible || ghostTitle !== 'Ghost Title' || realTitle === 'Ghost Title') {
  throw new Error('staging + ghost preview failed');
}

// 3. Human commits → flyer updates, ghost disappears
await page.click('.tx-card .tx-commit');
await sleep(600);
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`after commit: chip=${chip}, flyer title="${realTitle}"`);
if (chip !== 'committed' || realTitle !== 'Ghost Title') throw new Error('commit flow failed');

// 4. Undo → exact previous state
await page.click('#undo-btn');
await sleep(600);
realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`after undo: flyer title="${realTitle}"`);
if (realTitle === 'Ghost Title') throw new Error('undo flow failed');

// 5. Order prints: staged → committed → order appears
await page.evaluate(() => {
  window.__guard.dispatch('order_prints', { copies: 25, pageSize: 'A4' });
});
await sleep(400);
const orderCard = await page.$$eval('.tx-card .tx-chip', (els) => els[els.length - 1].textContent);
await page.$$eval('.tx-card .tx-commit', (btns) => btns[btns.length - 1].click());
await sleep(600);
const orders = await page.$$eval('#orders-list li', (lis) => lis.map((li) => li.textContent).join(' | '));
console.log(`order flow: proposal=${orderCard}, orders: ${orders}`);
if (!orders.includes('ORD-') || !orders.includes('25')) throw new Error('order flow failed');

// 6. Decline flow: proposal → decline → state unchanged
await page.evaluate(() => {
  window.__guard.dispatch('edit_flyer', { title: 'SHOULD NOT APPLY' });
});
await sleep(400);
const declineBtns = await page.$$('.tx-card .tx-decline');
await declineBtns[declineBtns.length - 1].click();
await sleep(400);
realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`after decline: flyer title="${realTitle}"`);
if (realTitle === 'SHOULD NOT APPLY') throw new Error('decline flow failed');

// 7. Audit trail populated
const logLen = await page.$$eval('#activity-log li', (lis) => lis.length);
console.log(`audit entries: ${logLen}`);
if (logLen < 10) throw new Error('audit trail too short');

console.log('\nATELIER E2E: ALL OK');
await browser.close();
