/**
 * REAL WebMCP e2e — Atelier + Redini v3 (see docs/PLAN.md, milestone v3).
 *
 * The primary integration proof: drives document.modelContext.getTools() and
 * executeTool() directly (the exact surface a WebMCP agent uses), with pure DOM
 * interaction for the human side. It does NOT use window.__guard (that handle
 * only exists with ?debug=1, on purpose).
 *
 * Flow: ONE intent → ONE design_update call → ONE ChangeSet (3 ops) → pending
 * until human decision → amend op-1 via the typed text control and op-3 (move)
 * via the typed number controls → skip op-2 → commit the subset → direct
 * structured result → 4-section receipt → undo → decline a second invocation →
 * click a template through the human path (also a ChangeSet) → zero unexpected
 * console/page errors.
 *
 * Usage: node scripts/atelier-e2e.mjs
 * Requires: dev server on http://localhost:5173, Chrome 149+ (WebMCP flag).
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5173/?clean=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-features=WebMCP', '--no-first-run', '--disable-extensions', '--user-data-dir=/tmp/atelier-chrome-profile'],
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.goto(URL, { waitUntil: 'networkidle2' });
await sleep(600);

const badge = await page.$eval('#webmcp-status', (el) => el.textContent);
console.log(`badge: ${badge}`);
assert(badge.startsWith('WebMCP available'), `WebMCP badge missing, got "${badge}"`);

// ---------- (0) no debug handle on ?clean=1 ----------
const hasGuardHandle = await page.evaluate(() => typeof window.__guard !== 'undefined');
console.log(`window.__guard exposed: ${hasGuardHandle} (must be false on ?clean=1)`);
assert(!hasGuardHandle, '?clean=1 must NOT expose window.__guard (debug-only handle)');

// ---------- (1) tool surface: EXACTLY the fixed 5 tools ----------
const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name));
console.log(`tools (${tools.length}): ${tools.join(', ')}`);
assert(tools.length === 5, `expected exactly 5 tools, got ${tools.length}: ${tools.join(', ')}`);
for (const t of ['design_update', 'list_templates', 'get_current_design', 'filter_templates', 'get_vendor_content']) {
  assert(tools.includes(t), `missing tool: ${t}`);
}
assert(!tools.some((t) => t.startsWith('select_variant_')), 'dynamic variant tools must not exist');
const designUpdateSchema = await page.evaluate(async () => {
  const defs = await document.modelContext.getTools();
  const d = defs.find((t) => t.name === 'design_update');
  if (!d || typeof d.inputSchema !== 'string') return null;
  const schema = JSON.parse(d.inputSchema); // getTools serializes inputSchema as a JSON string
  return {
    required: schema.required,
    kindBranches: schema.properties?.operations?.items?.oneOf?.length,
    additionalProperties: schema.additionalProperties,
  };
});
console.log(`design_update schema: ${JSON.stringify(designUpdateSchema)}`);
assert(
  designUpdateSchema && designUpdateSchema.required?.includes('operations'),
  'design_update must register a strict inputSchema',
);
assert(designUpdateSchema.kindBranches === 5, 'schema must have one branch per kind (5)');
assert(designUpdateSchema.additionalProperties === false, 'schema must forbid extra top-level keys');

// ---------- (2) ONE intent → ONE WebMCP call, stored without awaiting ----------
await page.evaluate(() => {
  const input = {
    intent: 'Make the poster more minimal',
    operations: [
      { kind: 'setText', params: { field: 'title', value: 'Ghost Title' } },
      { kind: 'setFill', params: { target: 'background', value: '#224466' } },
      { kind: 'move', params: { x: 40, y: 40 } },
    ],
  };
  const p = (async () => {
    const defs = await document.modelContext.getTools();
    const def = defs.find((t) => t.name === 'design_update');
    // executeTool(registeredTool, argsAsJsonString) — the REAL WebMCP surface.
    return document.modelContext.executeTool(def, JSON.stringify(input));
  })();
  // The invocation must stay PENDING until the human decides.
  window.__e2ePending = Promise.race([
    p.then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 400)),
  ]);
  window.__e2ePromise = p;
});

// ---------- (3) still pending after ~400ms ----------
const pendingState = await page.evaluate(() => window.__e2ePending);
console.log(`invocation after 400ms: ${pendingState}`);
assert(pendingState === 'pending', 'the executeTool promise must stay pending until the human decision');

// ---------- (4) card with 3 op rows + ghost preview with the proposed title ----------
await page.waitForSelector('.tx-card .tx-chip', { timeout: 3000 });
let chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const opRows = await page.$$eval('.tx-card .tx-op', (rows) => rows.length);
const ghostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
const realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`staged: chip=${chip}, ops=${opRows}, ghost="${ghostTitle}", real flyer="${realTitle}"`);
assert(chip === 'proposed', `chip should be "proposed", got "${chip}"`);
assert(opRows === 3, `expected 3 op rows, got ${opRows}`);
assert(ghostTitle === 'Ghost Title', `ghost should show the proposed title, got "${ghostTitle}"`);
assert(realTitle !== 'Ghost Title', 'real flyer must not change before commit');

// ---------- (5) amend op-1 through the TYPED UI controls (no JSON editing) ----------
const firstRow = (await page.$$('.tx-card .tx-op'))[0];
const editBtn = await firstRow.$('.op-edit-btn');
await editBtn.click();
await page.waitForSelector('.tx-edit-form', { timeout: 3000 });
const field = await page.$('.tx-edit-form input[type="text"]');
assert(field, 'setText amend form must have a text input');
// Set the amended value through the real input element (with an input event).
await page.$eval('.tx-edit-form input[type="text"]', (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, 'Amended Title');
await page.click('.tx-edit-form .tx-save');
await sleep(400);
const amendedGhost = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
console.log(`after typed amend: ghost="${amendedGhost}"`);
assert(amendedGhost === 'Amended Title', `ghost must track the amended value, got "${amendedGhost}"`);

// ---------- (6) amend op-3 (move) through the typed NUMBER controls ----------
const moveRow = (await page.$$('.tx-card .tx-op'))[2];
const moveEditBtn = await moveRow.$('.op-edit-btn');
await moveEditBtn.click();
await page.waitForSelector('.tx-edit-form input[type="number"]', { timeout: 3000 });
const numberInputs = await page.$$('.tx-edit-form input[type="number"]');
assert(numberInputs.length === 2, `move amend form must have x and y number inputs, got ${numberInputs.length}`);
await page.$$eval('.tx-edit-form input[type="number"]', (els, vals) => {
  els[0].value = vals[0];
  els[0].dispatchEvent(new Event('input', { bubbles: true }));
  els[1].value = vals[1];
  els[1].dispatchEvent(new Event('input', { bubbles: true }));
}, ['120', '90']);
await page.click('.tx-edit-form .tx-save');
await sleep(400);
const ghostLogoLeft = await page.$eval('#flyer-ghost .logo-badge', (el) => el.style.left);
const ghostLogoTop = await page.$eval('#flyer-ghost .logo-badge', (el) => el.style.top);
console.log(`after typed move amend: ghost logo.left=${ghostLogoLeft}, logo.top=${ghostLogoTop}`);
assert(ghostLogoLeft === '120px', `ghost must track the amended x, got ${ghostLogoLeft}`);
assert(ghostLogoTop === '90px', `ghost must track the amended y, got ${ghostLogoTop}`);

// ---------- (7) skip op-2 (background) via its checkbox → ghost reflects it ----------
const checkboxes = await page.$$('.tx-card .tx-op input[type="checkbox"]');
await checkboxes[1].click();
await sleep(400);
const ghostBg = await page.$eval('#flyer-ghost', (el) => el.style.background);
console.log(`after skip: ghost background=${ghostBg} (must NOT be the skipped #224466)`);
assert(ghostBg !== 'rgb(34, 68, 102)', 'the skipped fill must disappear from the ghost preview');

// ---------- (8) commit → await the stored promise → direct structured result ----------
await page.click('.tx-card .tx-commit');
let rawResult = await page.evaluate(() => window.__e2ePromise);
// WebMCP transport serializes results as JSON strings; parse what was returned.
const result = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
console.log(`agent result: ${JSON.stringify(result)}`);
assert(result.status === 'committed', `expected committed, got ${result.status}`);
assert(result.appliedCount === 2, `expected appliedCount 2, got ${result.appliedCount}`);
assert(result.amendedCount === 2, `expected amendedCount 2, got ${result.amendedCount}`);
assert(result.skippedCount === 1, `expected skippedCount 1, got ${result.skippedCount}`);
assert(result.undoAvailable === true, 'a fresh commit must offer undo');
assert(result.changeSetId, 'result must carry changeSetId');
assert(!('error' in result), `unexpected error field: ${JSON.stringify(result.error)}`);

// ---------- (9) flyer: amended title + amended move applied, skipped background UNCHANGED ----------
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const flyerTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const flyerBg = await page.$eval('#flyer', (el) => el.style.background);
const logoLeft = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
const logoTop = await page.$eval('#flyer .logo-badge', (el) => el.style.top);
console.log(`after commit: chip=${chip}, title="${flyerTitle}", bg=${flyerBg}, logo.left=${logoLeft}, logo.top=${logoTop}`);
assert(chip === 'committed', `chip should be "committed", got "${chip}"`);
assert(flyerTitle === 'Amended Title', `amended title must be applied, got "${flyerTitle}"`);
assert(flyerBg === 'rgb(255, 253, 248)', `skipped background must be UNCHANGED, got ${flyerBg}`);
assert(logoLeft === '120px', `amended move x must be applied, logo.left=${logoLeft}`);
assert(logoTop === '90px', `amended move y must be applied, logo.top=${logoTop}`);

// ---------- (10) receipt: all 4 sections with the correct values ----------
const receiptText = await page.$eval('.receipt-pre', (el) => el.textContent);
console.log(`receipt:\n${receiptText}`);
assert(receiptText.includes('INTENDED'), 'receipt must contain INTENDED');
assert(receiptText.includes('AMENDED BY HUMAN'), 'receipt must contain AMENDED BY HUMAN');
assert(receiptText.includes('SKIPPED BY HUMAN'), 'receipt must contain SKIPPED BY HUMAN');
assert(receiptText.includes('APPLIED (committed values)'), 'receipt must contain APPLIED');
assert(receiptText.includes('title → "Ghost Title"'), 'INTENDED must keep the agent original label');
assert(receiptText.includes('was: title → "Ghost Title"'), 'AMENDED BY HUMAN must show before → after');
assert(receiptText.includes('title → "Amended Title"'), 'AMENDED/APPLIED must show the committed label');
assert(receiptText.includes('background fill → #224466'), 'SKIPPED BY HUMAN must list the skipped op');
assert(receiptText.includes('logo → (40, 40)'), 'INTENDED must keep the agent original move label');
assert(receiptText.includes('was: logo → (40, 40)'), 'AMENDED BY HUMAN must show the move before → after');
assert(receiptText.includes('logo → (120, 90)'), 'AMENDED/APPLIED must show the committed move label');

// ---------- (11) undo: exact prior state restored ----------
await page.click('#undo-btn');
await sleep(500);
const undoneTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const undoneLeft = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
const undoneTop = await page.$eval('#flyer .logo-badge', (el) => el.style.top);
const undoneBg = await page.$eval('#flyer', (el) => el.style.background);
console.log(`after undo: title="${undoneTitle}", bg=${undoneBg}, logo.left=${undoneLeft}, logo.top=${undoneTop}`);
assert(undoneTitle === 'Spring Market on Main Street', `undo must restore the original title, got "${undoneTitle}"`);
assert(undoneLeft === '500px', `undo must restore the original logo position, got ${undoneLeft}`);
assert(undoneTop === '40px', `undo must restore the original logo top, got ${undoneTop}`);
assert(undoneBg === 'rgb(255, 253, 248)', `undo must restore the original background, got ${undoneBg}`);
const ghostHidden = await page.$eval('#flyer-ghost', (el) => el.classList.contains('hidden'));
assert(ghostHidden, 'the ghost preview must be gone after the ChangeSet reached a terminal status');

// ---------- (12) second invocation → declined via the UI → no mutation ----------
await page.evaluate(() => {
  const input = {
    intent: 'Should be declined',
    operations: [{ kind: 'setText', params: { field: 'title', value: 'SHOULD NOT APPLY' } }],
  };
  window.__e2ePromise2 = (async () => {
    const defs = await document.modelContext.getTools();
    const def = defs.find((t) => t.name === 'design_update');
    return document.modelContext.executeTool(def, JSON.stringify(input));
  })();
});
await page.waitForSelector('.tx-card:last-child .tx-decline', { timeout: 3000 });
await page.click('.tx-card:last-child .tx-decline');
rawResult = await page.evaluate(() => window.__e2ePromise2);
const declined = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
console.log(`decline result: ${JSON.stringify(declined)}`);
assert(declined.status === 'declined_by_user', `expected declined_by_user, got ${declined.status}`);
assert(declined.appliedCount === 0 && declined.undoAvailable === false, 'declined result must be empty and non-undoable');
const finalTitle = await page.$eval('#flyer h2', (el) => el.textContent);
assert(finalTitle === 'Spring Market on Main Street', `decline must not mutate anything, got "${finalTitle}"`);
const declinedChip = await page.$eval('.tx-card:last-child .tx-chip', (el) => el.textContent);
assert(declinedChip === 'declined', `declined card chip should read "declined", got "${declinedChip}"`);

// ---------- (13) template gallery: the human path also flows through a ChangeSet ----------
const galaClicked = await page.evaluate(() => {
  const lis = [...document.querySelectorAll('#template-list li')];
  const target = lis.find((li) => li.querySelector('strong')?.textContent === 'Evening Gala');
  if (!target) return false;
  target.click();
  return true;
});
assert(galaClicked, 'template gallery must offer Evening Gala');
await sleep(500);
const tplBg = await page.$eval('#flyer', (el) => el.style.background);
const tplTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const tplChip = await page.$eval('.tx-card:last-child .tx-chip', (el) => el.textContent);
console.log(`after template click: bg=${tplBg}, title="${tplTitle}", last chip=${tplChip}`);
assert(tplBg === 'rgb(20, 20, 32)', `template click must apply the chosen design through the human path, bg=${tplBg}`);
assert(tplTitle === 'Spring Market on Main Street', 'template click must keep the title (templates only set fills/font)');
assert(tplChip === 'committed', `the template ChangeSet must commit instantly, chip="${tplChip}"`);

// ---------- (14) zero unexpected console/page errors ----------
console.log(`console errors: ${consoleErrors.length}, page errors: ${pageErrors.length}`);
if (consoleErrors.length || pageErrors.length) {
  console.log('console:', consoleErrors.join('\n'));
  console.log('pageerrors:', pageErrors.join('\n'));
}
assert(consoleErrors.length === 0, `unexpected console errors: ${consoleErrors.join(' | ')}`);
assert(pageErrors.length === 0, `unexpected page errors: ${pageErrors.join(' | ')}`);

console.log('\nATELIER + REDINI v3 E2E: ALL OK');
await browser.close();
