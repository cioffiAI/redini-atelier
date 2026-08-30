/**
 * E2E check: Redini playground wired into the real app.
 * Uses the locally installed Chrome with the WebMCP feature flag against the dev server.
 *
 * Usage: node scripts/playground-e2e.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-features=WebMCP', '--no-first-run', '--disable-extensions', '--user-data-dir=/tmp/pg-chrome-profile'],
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle2' });
await sleep(1500);

const badge = await page.$eval('#webmcp-status', (el) => el.textContent);
console.log(`badge: ${badge}`);

// 1. Agent-side discovery includes the playground tools
const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name));
console.log(`tools: ${tools.join(', ')}`);
if (!tools.includes('set_count') || !tools.includes('list_templates')) throw new Error('playground tools not registered');

// 2. Simulate agent proposal via UI button
await page.click('#propose-42');
await page.waitForSelector('.tx-card .tx-chip', { timeout: 3000 });
let chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
console.log(`proposal staged: ${chip}`);

// 3. Human commits
await page.click('.tx-card .tx-commit');
await sleep(600);
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const count = await page.$eval('#counter-value', (el) => el.textContent);
console.log(`after commit: chip=${chip}, counter=${count}`);
if (chip !== 'committed' || count !== '42') throw new Error('commit flow failed');

// 4. Undo
await page.click('#undo-btn');
await sleep(600);
const countAfterUndo = await page.$eval('#counter-value', (el) => el.textContent);
console.log(`after undo: counter=${countAfterUndo}`);
if (countAfterUndo !== '0') throw new Error('undo flow failed');

// 5. Propose + decline
await page.click('#propose-7');
await page.waitForSelector('.tx-card .tx-chip', { timeout: 3000 });
const cards = await page.$$('.tx-card');
const lastCard = cards[cards.length - 1];
await lastCard.$eval('.tx-decline', (el) => el.click());
await sleep(600);
const finalCount = await page.$eval('#counter-value', (el) => el.textContent);
console.log(`after decline: counter=${finalCount}`);
if (finalCount !== '0') throw new Error('decline flow failed');

// 6. Audit trail non-empty
const logLen = await page.$$eval('#activity-log li', (lis) => lis.length);
console.log(`audit entries: ${logLen}`);
if (logLen < 5) throw new Error('audit trail too short');

console.log('\nPLAYGROUND E2E: ALL OK');
await browser.close();
