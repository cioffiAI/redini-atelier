/**
 * E2E check: Atelier + Redini v3 (multi-operation ChangeSet).
 * Implements the go/no-go criterion: correct a parameter, reject a single
 * operation, apply the subset, show a coherent receipt — no verbal explanation.
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

const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name));
console.log(`tools (${tools.length}): ${tools.join(', ')}`);
for (const t of ['design_update', 'list_templates', 'get_current_design', 'filter_templates', 'get_vendor_content']) {
  if (!tools.includes(t)) throw new Error(`missing tool: ${t}`);
}

// 1. ONE agent intent → ONE call → ONE ChangeSet with 3 operations
await page.evaluate(() => {
  window.__guard.dispatch('design_update', {
    intent: 'Make the poster more minimal',
    operations: [
      { kind: 'setText', params: { field: 'title', value: 'Ghost Title' } },
      { kind: 'setFill', params: { target: 'background', value: '#224466' } },
      { kind: 'move', params: { x: 40, y: 40 } },
    ],
  });
});
await page.waitForSelector('.tx-card .tx-chip', { timeout: 3000 });
const csId = await page.evaluate(() => window.__guard.getChangeSets().at(-1).id);
let chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const opRows = await page.$$eval('.tx-card .tx-op', (rows) => rows.length);
const ghostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
let realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`staged: chip=${chip}, ops=${opRows}, ghost="${ghostTitle}", real flyer="${realTitle}"`);
if (chip !== 'proposed' || opRows !== 3 || ghostTitle !== 'Ghost Title' || realTitle === 'Ghost Title') {
  throw new Error('ChangeSet staging failed');
}

// 2. Cherry-pick: skip op-2 (background) via its checkbox
const checkboxes = await page.$$('.tx-card .tx-op input[type="checkbox"]');
await checkboxes[1].click();
await sleep(400);

// 3. Amend op-1 (title) — the human corrects the agent's parameter
await page.evaluate((id) => {
  window.__guard.amendOperation(id, 'op-1', { field: 'title', value: 'Amended Title' });
}, csId);
await sleep(400);
const amendedTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
console.log(`after amend+skip: ghost title="${amendedTitle}" (ghost tracks the negotiated subset)`);
if (amendedTitle !== 'Amended Title') throw new Error('amendment did not reach the ghost preview');

// 4. Atomic commit of the subset
await page.click('.tx-card .tx-commit');
await sleep(600);
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const bg = await page.$eval('#flyer', (el) => el.style.background);
const logoLeft = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
const receiptText = await page.$eval('.receipt-pre', (el) => el.textContent);
console.log(`after commit: chip=${chip}, title="${realTitle}", bg=${bg}, logo.left=${logoLeft}`);
console.log(`receipt:\n${receiptText}`);
if (chip !== 'committed') throw new Error('commit failed');
if (realTitle !== 'Amended Title') throw new Error('amended op not applied');
if (bg === 'rgb(34, 68, 102)') throw new Error('skipped op was applied anyway'); // bg must NOT be #224466
if (bg !== 'rgb(255, 253, 248)') throw new Error(`original background unexpectedly changed: ${bg}`);
if (logoLeft !== '40px') throw new Error('move op not applied');
if (!receiptText.includes('SKIPPED BY HUMAN') || !receiptText.includes('AMENDED BY HUMAN')) {
  throw new Error('receipt does not record the negotiation');
}

// 5. Deterministic undo
await page.click('#undo-btn');
await sleep(600);
realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const logoLeftAfterUndo = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
console.log(`after undo: title="${realTitle}", logo.left=${logoLeftAfterUndo}`);
if (realTitle === 'Amended Title' || logoLeftAfterUndo === '40px') throw new Error('undo failed');

// 6. Decline: another intent, declined in full
await page.evaluate(() => {
  window.__guard.dispatch('design_update', {
    intent: 'Should be declined',
    operations: [{ kind: 'setText', params: { field: 'title', value: 'SHOULD NOT APPLY' } }],
  });
});
await sleep(400);
const declineBtns = await page.$$('.tx-card .tx-decline');
await declineBtns[declineBtns.length - 1].click();
await sleep(400);
const finalTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`after decline: title="${finalTitle}"`);
if (finalTitle === 'SHOULD NOT APPLY') throw new Error('decline failed');

console.log('\nATELIER + REDINI v3 E2E: ALL OK');
await browser.close();
