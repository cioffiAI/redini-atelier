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
 * structured result → 4-section receipt → button undo → button redo → decline a
 * second invocation → click a template through the human path (also a
 * ChangeSet) → keyboard undo/redo (⌘Z / ⇧⌘Z / Ctrl+Y) → stale-proposal flow
 * (undo under a pending ChangeSet, STALE_TRANSACTION on commit) → zero
 * unexpected console/page errors.
 *
 * Usage: node scripts/atelier-e2e.mjs
 * Requires: dev server on http://localhost:5173, Chrome 149+ (WebMCP flag).
 */
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = `${os.tmpdir()}${path.sep}atelier-chrome-profile`;
const URL = 'http://localhost:5173/?clean=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-features=WebMCP', '--no-first-run', '--disable-extensions', `--user-data-dir=${PROFILE}`],
});
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

/** Editor keyboard steps must target the document body, never an input. */
async function focusBody() {
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  });
  await sleep(100);
}

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

// ---------- (4) card with 3 op rows + COHERENT staged preview ----------
await page.waitForSelector('.tx-card .tx-chip', { timeout: 3000 });
let chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const opRows = await page.$$eval('.tx-card .tx-op', (rows) => rows.length);
const ghostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
const realTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const previewingStaged = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
const flyerVisibilityStaged = await page.$eval('#flyer', (el) => getComputedStyle(el).visibility);
console.log(`staged: chip=${chip}, ops=${opRows}, ghost="${ghostTitle}", real flyer="${realTitle}", previewing=${previewingStaged}, #flyer visibility=${flyerVisibilityStaged}`);
assert(chip === 'Proposed', `chip should be "Proposed", got "${chip}"`);
// The card reads as the agent's INTENT + count subtitle (presentation only).
const cardHeading = await page.$eval('.tx-card .tx-heading', (el) => el.textContent);
const cardSubtitle = await page.$eval('.tx-card .tx-subtitle', (el) => el.textContent);
console.log(`card: heading="${cardHeading}", subtitle="${cardSubtitle}"`);
assert(cardHeading.includes('Make the poster more minimal'), `card heading must carry the agent intent, got "${cardHeading}"`);
assert(cardSubtitle === '3 proposed changes', `card subtitle must count the proposals, got "${cardSubtitle}"`);
// Human op headings (no raw tool/kind names as primary UI).
const opHeadings = await page.$$eval('.tx-card .tx-op .op-heading', (els) => els.map((e) => e.textContent));
console.log(`op headings: ${opHeadings.join(', ')}`);
assert(opHeadings.join('|') === 'Title|Background|Logo position', `op rows must use human headings, got ${JSON.stringify(opHeadings)}`);
assert(opRows === 3, `expected 3 op rows, got ${opRows}`);
assert(ghostTitle === 'Ghost Title', `ghost should show the proposed title, got "${ghostTitle}"`);
assert(realTitle !== 'Ghost Title', 'real flyer must not change before commit');
// ONE coherent staged state: the committed flyer is NOT visible under the ghost.
assert(previewingStaged, '#flyer-wrap must carry the previewing class while a ChangeSet is staged');
assert(flyerVisibilityStaged === 'hidden', `#flyer must be visibility:hidden while previewing, got "${flyerVisibilityStaged}"`);
// The a11y pairing mirrors the visibility: during a preview the GHOST is the
// meaningful content (never aria-hidden) and the covered #flyer is hidden from
// assistive tech too.
const ghostAriaStaged = await page.$eval('#flyer-ghost', (el) => el.getAttribute('aria-hidden'));
const flyerAriaStaged = await page.$eval('#flyer', (el) => el.getAttribute('aria-hidden'));
assert(ghostAriaStaged === null, 'the ghost must NOT be aria-hidden while it is the meaningful preview');
assert(flyerAriaStaged === 'true', `the covered #flyer must be aria-hidden while previewing, got "${flyerAriaStaged}"`);
// The canvas status reflects the preview state and names the owning intent.
const canvasStatusStaged = await page.$eval('#canvas-status', (el) => el.textContent);
console.log(`canvas status while staged: "${canvasStatusStaged}"`);
assert(
  canvasStatusStaged === 'Preview — not applied yet · Make the poster more minimal',
  `canvas status must announce the preview with its intent, got "${canvasStatusStaged}"`,
);
// The ghost badge NAMES the proposal owning the preview (single-slot ownership).
const badgeStaged = await page.$eval('#ghost-badge', (el) => el.textContent);
assert(badgeStaged.includes('Make the poster more minimal'), `the badge must name the owning intent, got "${badgeStaged}"`);
assert(badgeStaged.startsWith('PREVIEW'), `the badge must stay in preview voice, got "${badgeStaged}"`);

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
// The commit CTA is primary and counts the INCLUDED subset dynamically (2 of 3).
const commitLabel = await page.$eval('.tx-card .tx-commit', (el) => el.textContent);
console.log(`commit label: "${commitLabel}"`);
assert(commitLabel === 'Commit 2 changes', `commit button must read "Commit 2 changes", got "${commitLabel}"`);
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

// ---------- (9) flyer: amended title + amended move applied, skipped background UNCHANGED; previewing gone ----------
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
const flyerTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const flyerBg = await page.$eval('#flyer', (el) => el.style.background);
const logoLeft = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
const logoTop = await page.$eval('#flyer .logo-badge', (el) => el.style.top);
const previewingAfterCommit = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
const flyerVisibilityAfterCommit = await page.$eval('#flyer', (el) => getComputedStyle(el).visibility);
console.log(`after commit: chip=${chip}, title="${flyerTitle}", bg=${flyerBg}, logo.left=${logoLeft}, logo.top=${logoTop}`);
assert(chip === 'Committed', `chip should be "Committed", got "${chip}"`);
assert(flyerTitle === 'Amended Title', `amended title must be applied, got "${flyerTitle}"`);
assert(flyerBg === 'rgb(255, 253, 248)', `skipped background must be UNCHANGED, got ${flyerBg}`);
assert(logoLeft === '120px', `amended move x must be applied, logo.left=${logoLeft}`);
assert(logoTop === '90px', `amended move y must be applied, logo.top=${logoTop}`);
assert(!previewingAfterCommit, '#flyer-wrap must NOT be previewing after commit');
assert(flyerVisibilityAfterCommit !== 'hidden', `#flyer must be visible again after commit, visibility="${flyerVisibilityAfterCommit}"`);
// The canvas status line reflects the real decision.
const canvasStatus = await page.$eval('#canvas-status', (el) => el.textContent);
assert(canvasStatus === 'Committed', `canvas status must read "Committed" after the commit, got "${canvasStatus}"`);
// The user-facing activity log speaks human: counted summary, per-op lines,
// NO tool names / raw ids / JSON.
const activityAfter = await page.$eval('#activity-log', (el) => el.textContent);
console.log(`activity after commit (first 220 chars): ${activityAfter.slice(0, 220).replace(/\n/g, ' | ')}`);
assert(activityAfter.includes('Agent proposed 3 changes'), 'activity must open with the agent proposal count');
assert(activityAfter.includes('You amended Title'), 'activity must record the title amendment humanly');
assert(activityAfter.includes('You amended Logo position'), 'activity must record the logo amendment humanly');
assert(activityAfter.includes('You skipped Background'), 'activity must record the skip humanly');
assert(activityAfter.includes('Committed 2 of 3 changes'), 'activity must summarize the committed subset humanly');
assert(!activityAfter.includes('{'), 'user-facing activity must NOT contain raw JSON');
assert(!activityAfter.includes('design_update'), 'user-facing activity must NOT contain tool names');
assert(!activityAfter.includes('op-1') && !activityAfter.includes('op-2'), 'user-facing activity must NOT contain operation ids');

// ---------- (10) receipt: human 4-section summary + collapsed developer details ----------
const receiptSections = await page.$$eval('.receipt-section', (secs) =>
  secs.map((s) => ({
    title: s.querySelector('.receipt-title')?.textContent ?? '',
    text: (s.textContent ?? '').replace(/\s+/g, ' ').trim(),
  })),
);
const rec = (t) => receiptSections.find((s) => s.title === t);
assert(receiptSections.length === 4, `expected 4 receipt sections, got ${receiptSections.length}`);
for (const t of ['Intended', 'Amended by you', 'Skipped by you', 'Applied']) {
  assert(rec(t), `receipt must contain the "${t}" section`);
}
assert(rec('Intended').text.includes('"Ghost Title"'), 'Intended must keep the agent original title value');
assert(rec('Intended').text.includes('#224466'), 'Intended must list the agent background value');
assert(rec('Intended').text.includes('40, 40'), 'Intended must keep the agent original move value');
assert(rec('Amended by you').text.includes('"Ghost Title" → "Amended Title"'), 'Amended by you must show old → new for the title');
assert(rec('Amended by you').text.includes('40, 40 → 120, 90'), 'Amended by you must show old → new for the logo position');
assert(rec('Skipped by you').text.includes('#224466'), 'Skipped by you must list the skipped background');
assert(rec('Applied').text.includes('"Amended Title"'), 'Applied must carry the committed title value');
assert(rec('Applied').text.includes('120, 90'), 'Applied must carry the committed logo position');
assert(!rec('Applied').text.includes('#224466'), 'the skipped fill must NOT appear under Applied');
const receiptFooter = await page.$eval('.receipt-footer', (el) => el.textContent);
assert(/State v\d+ → v\d+/.test(receiptFooter), `receipt footer must read "State v… → v…", got "${receiptFooter}"`);
const receiptDev = await page.$eval('.receipt .dev-details summary', (el) => el.textContent);
assert(receiptDev === 'Developer details', 'receipt must expose collapsed developer details');
console.log(`receipt sections: ${receiptSections.map((s) => s.title).join(', ')} ; footer: "${receiptFooter}"`);

// ---------- (11) undo button: exact prior state restored; live button states ----------
await page.click('#undo-btn');
await sleep(500);
const undoneTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const undoneLeft = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
const undoneTop = await page.$eval('#flyer .logo-badge', (el) => el.style.top);
const undoneBg = await page.$eval('#flyer', (el) => el.style.background);
let undoDisabled = await page.$eval('#undo-btn', (el) => el.disabled);
let redoDisabled = await page.$eval('#redo-btn', (el) => el.disabled);
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
console.log(`after undo: title="${undoneTitle}", bg=${undoneBg}, logo.left=${undoneLeft}, logo.top=${undoneTop}, chip=${chip}, undo-btn.disabled=${undoDisabled}, redo-btn.disabled=${redoDisabled}`);
assert(undoneTitle === 'Spring Market on Main Street', `undo must restore the original title, got "${undoneTitle}"`);
assert(undoneLeft === '500px', `undo must restore the original logo position, got ${undoneLeft}`);
assert(undoneTop === '40px', `undo must restore the original logo top, got ${undoneTop}`);
assert(undoneBg === 'rgb(255, 253, 248)', `undo must restore the original background, got ${undoneBg}`);
assert(chip === 'Undone', `after undo the card chip should be "Undone", got "${chip}"`);
const canvasStatusAfterUndo = await page.$eval('#canvas-status', (el) => el.textContent);
assert(canvasStatusAfterUndo === 'Undone', `canvas status must read "Undone" after undo, got "${canvasStatusAfterUndo}"`);
assert(undoDisabled === true, 'undo of the only commit must disable #undo-btn (canUndo false)');
assert(redoDisabled === false, 'after an undo #redo-btn must be ENABLED (canRedo true)');
const ghostHidden = await page.$eval('#flyer-ghost', (el) => el.classList.contains('hidden'));
assert(ghostHidden, 'the ghost preview must be gone after the ChangeSet reached a terminal status');
const previewingAfterUndo = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
assert(!previewingAfterUndo, 'no previewing class after undo');

// ---------- (11.5) redo button: the EXACT negotiated committed state returns ----------
await page.click('#redo-btn');
await sleep(500);
const redoneTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const redoneLeft = await page.$eval('#flyer .logo-badge', (el) => el.style.left);
const redoneTop = await page.$eval('#flyer .logo-badge', (el) => el.style.top);
const redoneBg = await page.$eval('#flyer', (el) => el.style.background);
undoDisabled = await page.$eval('#undo-btn', (el) => el.disabled);
redoDisabled = await page.$eval('#redo-btn', (el) => el.disabled);
chip = await page.$eval('.tx-card .tx-chip', (el) => el.textContent);
console.log(`after redo: title="${redoneTitle}", bg=${redoneBg}, logo.left=${redoneLeft}, logo.top=${redoneTop}, chip=${chip}, undo-btn.disabled=${undoDisabled}, redo-btn.disabled=${redoDisabled}`);
assert(redoneTitle === 'Amended Title', `redo must restore the amended title, got "${redoneTitle}"`);
assert(redoneLeft === '120px', `redo must restore the amended move x, got ${redoneLeft}`);
assert(redoneTop === '90px', `redo must restore the amended move y, got ${redoneTop}`);
assert(redoneBg === 'rgb(255, 253, 248)', `the skipped background must stay UNCHANGED across redo, got ${redoneBg}`);
assert(chip === 'Committed', `after redo the chip should be "Committed" again, got "${chip}"`);
const canvasStatusAfterRedo = await page.$eval('#canvas-status', (el) => el.textContent);
assert(canvasStatusAfterRedo === 'Redone', `canvas status must read "Redone" after redo, got "${canvasStatusAfterRedo}"`);
assert(undoDisabled === false, 'after redo #undo-btn must be enabled again');
assert(redoDisabled === true, 'after redo of the only undone entry #redo-btn must be disabled');

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
assert(finalTitle === 'Amended Title', `decline must not mutate anything, got "${finalTitle}"`);
const declinedChip = await page.$eval('.tx-card:last-child .tx-chip', (el) => el.textContent);
assert(declinedChip === 'Declined', `declined card chip should read "Declined", got "${declinedChip}"`);

// ---------- (13) template gallery: real buttons, and the human path also flows through a ChangeSet ----------
// The gallery renders SEMANTIC <button> items (keyboard-focusable, not clickable <li>).
const tplButtons = await page.$$eval('#template-list button', (btns) =>
  btns.map((b) => ({
    tag: b.tagName,
    name: b.querySelector('strong')?.textContent ?? '',
  })),
);
console.log(`template buttons: ${tplButtons.map((b) => b.name).join(', ')}`);
assert(tplButtons.length === 4, `template gallery must render 4 buttons, got ${tplButtons.length}`);
assert(tplButtons.every((b) => b.tag === 'BUTTON'), 'template gallery items must be real <button> elements');
assert(tplButtons.some((b) => b.name === 'Evening Gala'), 'template gallery must offer Evening Gala');
const tplFocusable = await page.evaluate(() => {
  const b = document.querySelector('#template-list button');
  if (!b) return false;
  b.focus();
  return document.activeElement === b;
});
assert(tplFocusable, 'template buttons must be keyboard-focusable');

// Actor provenance: the click is a HUMAN action — it must NOT add an "Agent
// proposed" line; it must surface as "You staged Template …".
const agentProposedBeforeTpl = await page.$eval('#activity-log', (el) =>
  (el.textContent.match(/Agent proposed/g) ?? []).length,
);
const galaClicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#template-list button')];
  const target = btns.find((b) => b.querySelector('strong')?.textContent === 'Evening Gala');
  if (!target) return false;
  target.click();
  return true;
});
assert(galaClicked, 'the Evening Gala template button must be clickable');
await sleep(500);
const tplBg = await page.$eval('#flyer', (el) => el.style.background);
const tplTitle = await page.$eval('#flyer h2', (el) => el.textContent);
const tplChip = await page.$eval('.tx-card:last-child .tx-chip', (el) => el.textContent);
console.log(`after template click: bg=${tplBg}, title="${tplTitle}", last chip=${tplChip}`);
assert(tplBg === 'rgb(20, 20, 32)', `template click must apply the chosen design through the human path, bg=${tplBg}`);
assert(tplTitle === 'Amended Title', 'template click must keep the title (templates only set fills/font)');
assert(tplChip === 'Committed', `the template ChangeSet must commit instantly, chip="${tplChip}"`);
const agentProposedAfterTpl = await page.$eval('#activity-log', (el) =>
  (el.textContent.match(/Agent proposed/g) ?? []).length,
);
assert(
  agentProposedAfterTpl === agentProposedBeforeTpl,
  `the human template click must NOT add an "Agent proposed" line (${agentProposedBeforeTpl} → ${agentProposedAfterTpl})`,
);
const activityHeadTpl = await page.$eval('#activity-log', (el) => el.textContent.slice(0, 300));
assert(
  activityHeadTpl.includes('You staged Template'),
  `the activity must record the human staging as "You staged Template …", got "${activityHeadTpl}"`,
);

// ---------- (14) KEYBOARD history: ⌘Z undo / ⇧⌘Z redo / Ctrl+Y (exhausted) ----------
await focusBody();
await page.keyboard.down('Meta');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Meta');
await sleep(500);
const kbUndoBg = await page.$eval('#flyer', (el) => el.style.background);
undoDisabled = await page.$eval('#undo-btn', (el) => el.disabled);
redoDisabled = await page.$eval('#redo-btn', (el) => el.disabled);
console.log(`keyboard ⌘Z undo: bg=${kbUndoBg}, undo-btn.disabled=${undoDisabled}, redo-btn.disabled=${redoDisabled}`);
assert(kbUndoBg === 'rgb(255, 253, 248)', `⌘Z must undo the template ChangeSet, bg="${kbUndoBg}"`);
assert(undoDisabled === false, 'after ⌘Z undo #undo-btn must be enabled (first commit still undoable)');
assert(redoDisabled === false, 'after ⌘Z undo #redo-btn must be enabled');

await focusBody();
await page.keyboard.down('Shift');
await page.keyboard.down('Meta');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Meta');
await page.keyboard.up('Shift');
await sleep(500);
const kbRedoBg = await page.$eval('#flyer', (el) => el.style.background);
undoDisabled = await page.$eval('#undo-btn', (el) => el.disabled);
redoDisabled = await page.$eval('#redo-btn', (el) => el.disabled);
console.log(`keyboard ⇧⌘Z redo: bg=${kbRedoBg}, undo-btn.disabled=${undoDisabled}, redo-btn.disabled=${redoDisabled}`);
assert(kbRedoBg === 'rgb(20, 20, 32)', `⇧⌘Z must redo the template ChangeSet, bg="${kbRedoBg}"`);
assert(undoDisabled === false, 'after ⇧⌘Z redo #undo-btn must be enabled');
assert(redoDisabled === true, 'after ⇧⌘Z redo of the only undone entry #redo-btn must be disabled');

// Ctrl+Y with an EMPTY redo stack: NOTHING_TO_REDO surfaces, state unchanged.
await focusBody();
await page.keyboard.down('Control');
await page.keyboard.press('KeyY');
await page.keyboard.up('Control');
await sleep(400);
const kbEmptyRedoBg = await page.$eval('#flyer', (el) => el.style.background);
const activityLog = await page.$eval('#activity-log', (el) => el.textContent);
console.log(`keyboard Ctrl+Y (empty redo): bg=${kbEmptyRedoBg}, log has "Nothing to redo."=${activityLog.includes('Nothing to redo.')}`);
assert(kbEmptyRedoBg === 'rgb(20, 20, 32)', `Ctrl+Y must NOT change state when redo is exhausted, bg="${kbEmptyRedoBg}"`);
assert(activityLog.includes('Nothing to redo.'), 'the exhausted redo must surface the humanized "Nothing to redo." in the activity log');
// The technical code stays in DEVELOPER details only — never user-facing.
const devLog = await page.$eval('#dev-log', (el) => el.textContent);
assert(devLog.includes('NOTHING_TO_REDO'), 'the technical code must appear in the developer details log');
assert(!activityLog.includes('NOTHING_TO_REDO'), 'the raw error code must NOT leak into the user-facing activity');

// ---------- (15) stale-proposal flow: undo under a pending ChangeSet ----------
await page.evaluate(() => {
  const input = {
    intent: 'Will go stale',
    operations: [{ kind: 'setText', params: { field: 'title', value: 'STALE TITLE' } }],
  };
  window.__e2ePromise3 = (async () => {
    const defs = await document.modelContext.getTools();
    const def = defs.find((t) => t.name === 'design_update');
    return document.modelContext.executeTool(def, JSON.stringify(input));
  })();
});
await page.waitForSelector('.tx-card:last-child .tx-chip', { timeout: 3000 });
await sleep(300);
const staleGhostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
const previewingFresh = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
console.log(`stale flow staged: ghost="${staleGhostTitle}", previewing=${previewingFresh}`);
assert(staleGhostTitle === 'STALE TITLE', `the fresh proposal must paint its ghost, got "${staleGhostTitle}"`);
assert(previewingFresh === true, 'the fresh proposal must be previewing');

// Undo the template commit while the proposal is pending → the proposal goes stale.
await focusBody();
await page.keyboard.down('Meta');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Meta');
await sleep(500);
const staleBg = await page.$eval('#flyer', (el) => el.style.background);
const staleNoteVisible = await page.$eval('.tx-card:last-child', (el) => Boolean(el.querySelector('.tx-stale-note')));
const previewingStale = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
const ghostHiddenStale = await page.$eval('#flyer-ghost', (el) => el.classList.contains('hidden'));
console.log(`after undo under pending: bg=${staleBg}, stale-note=${staleNoteVisible}, previewing=${previewingStale}, ghost hidden=${ghostHiddenStale}`);
assert(staleBg === 'rgb(255, 253, 248)', `the ⌘Z must undo the template ChangeSet, bg="${staleBg}"`);
assert(staleNoteVisible === true, 'the pending card must show a visible stale hint (isStale)');
assert(previewingStale === false, 'a stale proposal must NOT keep the ghost preview on canvas');
assert(ghostHiddenStale === true, 'the ghost must be hidden while the pending proposal is stale');
// The stale hint must live on a card that STILL shows the pending chip.
const staleChip = await page.$eval('.tx-card:last-child .tx-chip', (el) => el.textContent);
assert(staleChip === 'Proposed', `the pending card must still be proposed/reviewing (lazy enforcement), got "${staleChip}"`);
// The stale hint is the human sentence (no STALE_TRANSACTION jargon in primary UI).
const staleNoteText = await page.$eval('.tx-card:last-child .tx-stale-note', (el) => el.textContent);
console.log(`stale note: "${staleNoteText}"`);
assert(staleNoteText.includes('ask the agent for a fresh proposal'), 'the stale hint must offer the human next step');

// ⌘Z while an amendment input is focused must NOT trigger atelier undo.
const pendingCard = (await page.$$('.tx-card')).at(-1);
const staleEditBtn = await pendingCard.$('.op-edit-btn');
await staleEditBtn.click();
await page.waitForSelector('.tx-card:last-child .tx-edit-form input[type="text"]', { timeout: 3000 });
await page.click('.tx-card:last-child .tx-edit-form input[type="text"]');
await sleep(150);
await page.keyboard.down('Meta');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Meta');
await sleep(400);
const inputValue = await page.$eval('.tx-card:last-child .tx-edit-form input[type="text"]', (el) => el.value);
const inputFocused = await page.evaluate(() => {
  const el = document.querySelector('.tx-card:last-child .tx-edit-form input[type="text"]');
  return document.activeElement === el;
});
const titleAfterInputUndo = await page.$eval('#flyer h2', (el) => el.textContent);
const bgAfterInputUndo = await page.$eval('#flyer', (el) => el.style.background);
console.log(`⌘Z in input: focused=${inputFocused}, value="${inputValue}", flyer title="${titleAfterInputUndo}", bg=${bgAfterInputUndo}`);
assert(inputFocused === true, 'the amendment input must keep focus after ⌘Z');
assert(inputValue === 'STALE TITLE', `the input value must be untouched by the guarded ⌘Z, got "${inputValue}"`);
assert(titleAfterInputUndo === 'Amended Title', `⌘Z inside an input must NOT undo the first commit, title="${titleAfterInputUndo}"`);
assert(bgAfterInputUndo === 'rgb(255, 253, 248)', `⌘Z inside an input must NOT change the canvas, bg="${bgAfterInputUndo}"`);
// the guarded keypress must not have produced a spurious history error either
const logAfterInputUndo = await page.$eval('#activity-log', (el) => el.textContent);
assert(
  !logAfterInputUndo.includes('Nothing to undo'),
  'the input-focused ⌘Z must not trigger a spurious atelier undo/error',
);

// Attempt to commit the stale proposal: STALE_TRANSACTION surfaces INLINE, no mutation.
await page.click('.tx-card:last-child .tx-commit');
await sleep(400);
const staleErrorText = await page.$eval('.tx-card:last-child', (el) => {
  const err = el.querySelector('.tx-error');
  return err ? err.textContent : '';
});
const staleChip2 = await page.$eval('.tx-card:last-child .tx-chip', (el) => el.textContent);
const bgAfterStaleCommit = await page.$eval('#flyer', (el) => el.style.background);
const titleAfterStaleCommit = await page.$eval('#flyer h2', (el) => el.textContent);
console.log(`stale commit attempt: error="${staleErrorText}", chip=${staleChip2}, bg=${bgAfterStaleCommit}, title="${titleAfterStaleCommit}"`);
assert(staleErrorText.includes('fresh proposal'), `the stale commit must surface the HUMANIZED STALE_TRANSACTION message, got "${staleErrorText}"`);
assert(staleErrorText.includes('STALE_TRANSACTION'), `the technical code must stay visible as a muted suffix, got "${staleErrorText}"`);
assert(staleChip2 === 'Stale', `the stale card chip must read "Stale", got "${staleChip2}"`);
assert(bgAfterStaleCommit === 'rgb(255, 253, 248)', 'STALE_TRANSACTION must apply nothing');
assert(titleAfterStaleCommit === 'Amended Title', 'STALE_TRANSACTION must apply nothing (title)');

// ---------- (16) TWO pending proposals: the ghost is a single slot and the badge names its CURRENT owner ----------
await page.evaluate(() => {
  const p1 = (async () => {
    const defs = await document.modelContext.getTools();
    const def = defs.find((t) => t.name === 'design_update');
    return document.modelContext.executeTool(def, JSON.stringify({
      intent: 'First of two pending',
      operations: [{ kind: 'setText', params: { field: 'title', value: 'PENDING ONE' } }],
    }));
  })();
  window.__e2ePendingA = p1;
});
await sleep(400);
const pendingAGhost = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
const badgeAfterA = await page.$eval('#ghost-badge', (el) => el.textContent);
console.log(`two-pending staged A: ghost="${pendingAGhost}", badge="${badgeAfterA}"`);
assert(pendingAGhost === 'PENDING ONE', `the first pending proposal must paint its ghost, got "${pendingAGhost}"`);
assert(badgeAfterA.includes('First of two pending'), `the badge must name the first owner, got "${badgeAfterA}"`);

await page.evaluate(() => {
  const p2 = (async () => {
    const defs = await document.modelContext.getTools();
    const def = defs.find((t) => t.name === 'design_update');
    return document.modelContext.executeTool(def, JSON.stringify({
      intent: 'Second of two pending',
      operations: [{ kind: 'setFill', params: { target: 'background', value: '#884422' } }],
    }));
  })();
  window.__e2ePendingB = p2;
});
await page.waitForFunction(
  () => [...document.querySelectorAll('.tx-card .tx-heading')].some((e) => e.textContent.includes('Second of two pending')),
  { timeout: 3000 },
);
await sleep(400);
const secondGhostBg = await page.$eval('#flyer-ghost', (el) => el.style.background);
const secondGhostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
const badgeAfterB = await page.$eval('#ghost-badge', (el) => el.textContent);
const canvasStatusTwoPending = await page.$eval('#canvas-status', (el) => el.textContent);
console.log(`two-pending staged B: ghost bg=${secondGhostBg}, ghost title="${secondGhostTitle}", badge="${badgeAfterB}"`);
assert(secondGhostBg === 'rgb(136, 68, 34)', `the ghost must reflect the SECOND proposal (last-emitter-wins), bg="${secondGhostBg}"`);
assert(secondGhostTitle !== 'PENDING ONE', 'the ghost must NOT keep the first proposal while the second owns it');
assert(badgeAfterB.includes('Second of two pending'), `the badge must name the CURRENT owner (the second), got "${badgeAfterB}"`);
assert(!badgeAfterB.includes('First of two pending'), `the badge must not claim the first proposal anymore, got "${badgeAfterB}"`);
assert(
  canvasStatusTwoPending === 'Preview — not applied yet · Second of two pending',
  `the canvas status must follow the current owner, got "${canvasStatusTwoPending}"`,
);
// The FIRST proposal's card is still present and still pending, with its proposed value visible.
const firstPendingCard = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.tx-card')];
  const card = cards.find((c) => c.querySelector('.tx-heading')?.textContent.includes('First of two pending'));
  if (!card) return null;
  return {
    chip: card.querySelector('.tx-chip')?.textContent ?? '',
    heading: card.querySelector('.op-heading')?.textContent ?? '',
    value: card.querySelector('.op-value')?.textContent ?? '',
  };
});
assert(firstPendingCard !== null, 'the FIRST proposal card must still be present when a second one owns the ghost');
assert(firstPendingCard.chip === 'Proposed', `the first card must still be pending, chip="${firstPendingCard.chip}"`);
assert(firstPendingCard.value.includes('PENDING ONE'), `the first card's proposed value must remain visible, value="${firstPendingCard.value}"`);

// ---------- (16.5) "Commit 0 changes" must be UNREACHABLE: real disabled attribute, recomputed per toggle ----------
const commitCard = (await page.$$('.tx-card')).at(-1); // 'Second of two pending', single setFill op
const commitCheckbox = await commitCard.$('.tx-op input[type="checkbox"]');
assert(commitCheckbox, 'the second pending card must have a toggleable operation');
await commitCheckbox.click(); // uncheck the ONLY operation → empty subset
await sleep(300);
const commitDisabled0 = await page.$eval('.tx-card:last-child .tx-commit', (el) => el.disabled);
const commitLabel0 = await page.$eval('.tx-card:last-child .tx-commit', (el) => el.textContent);
console.log(`all ops unchecked: commit disabled=${commitDisabled0}, label="${commitLabel0}"`);
assert(commitLabel0 === 'Commit 0 changes', `commit label must count the empty subset, got "${commitLabel0}"`);
assert(commitDisabled0 === true, 'the Commit button must be DISABLED (real disabled attribute) at 0 included operations');
// Re-include one operation → the button enables again on the re-render.
const commitCheckboxAgain = await commitCard.$('.tx-op input[type="checkbox"]');
await commitCheckboxAgain.click();
await sleep(300);
const commitDisabled1 = await page.$eval('.tx-card:last-child .tx-commit', (el) => el.disabled);
const commitLabel1 = await page.$eval('.tx-card:last-child .tx-commit', (el) => el.textContent);
console.log(`re-checked: commit disabled=${commitDisabled1}, label="${commitLabel1}"`);
assert(commitDisabled1 === false, 'the Commit button must re-enable when an operation is re-included');
assert(commitLabel1 === 'Commit 1 change', `commit label must recount the subset, got "${commitLabel1}"`);

// Cleanup: decline both pending proposals (settles the agent promises, no mutation).
await page.click('.tx-card:last-child .tx-decline');
await sleep(300);
rawResult = await page.evaluate(() => window.__e2ePendingB);
const declinedB = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
assert(declinedB.status === 'declined_by_user', `the second proposal must decline cleanly, got ${declinedB.status}`);
// ---------- (16.6) PROMOTION: the declined B owned the ghost slot — the FIRST
// proposal's cached preview must be restored (multi-pending single-slot fallback) ----------
const promotedGhostTitle = await page.$eval('#flyer-ghost h2', (el) => el.textContent);
const promotedGhostBg = await page.$eval('#flyer-ghost', (el) => el.style.background);
const badgeAfterPromotion = await page.$eval('#ghost-badge', (el) => el.textContent);
const previewingAfterPromotion = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
console.log(`after declining B: promoted ghost="${promotedGhostTitle}", bg=${promotedGhostBg}, badge="${badgeAfterPromotion}", previewing=${previewingAfterPromotion}`);
assert(promotedGhostTitle === 'PENDING ONE', `the FIRST proposal's preview must return after the second was declined, got "${promotedGhostTitle}"`);
assert(promotedGhostBg === 'rgb(255, 253, 248)', `the restored ghost must carry the FIRST proposal's design, bg="${promotedGhostBg}"`);
assert(badgeAfterPromotion.includes('First of two pending'), `the badge must name the restored owner, got "${badgeAfterPromotion}"`);
assert(!badgeAfterPromotion.includes('Second of two pending'), `the badge must not name the declined proposal anymore, got "${badgeAfterPromotion}"`);
assert(badgeAfterPromotion.startsWith('PREVIEW'), 'the promoted badge must stay in preview voice');
assert(previewingAfterPromotion === true, 'the restored preview must keep the previewing state');
// The first proposal's card is no longer last (the declined second card is):
// address it by its intent like the assertions above.
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.tx-card')];
  const card = cards.find((c) => c.querySelector('.tx-heading')?.textContent.includes('First of two pending'));
  const btn = card?.querySelector('.tx-decline');
  if (!btn) throw new Error('first pending card decline button not found');
  btn.click();
});
await sleep(300);
rawResult = await page.evaluate(() => window.__e2ePendingA);
const declinedA = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
assert(declinedA.status === 'declined_by_user', `the first proposal must decline cleanly, got ${declinedA.status}`);
const pendingGhostGone = await page.$eval('#flyer-ghost', (el) => el.classList.contains('hidden'));
assert(pendingGhostGone, 'the ghost must be gone after both pending proposals reached a terminal status');
const previewingAfterBothDeclined = await page.$eval('#flyer-wrap', (el) => el.classList.contains('previewing'));
assert(!previewingAfterBothDeclined, 'no previewing class after both proposals were declined');

// ---------- (17) zero unexpected console/page errors ----------
console.log(`console errors: ${consoleErrors.length}, page errors: ${pageErrors.length}`);
if (consoleErrors.length || pageErrors.length) {
  console.log('console:', consoleErrors.join('\n'));
  console.log('pageerrors:', pageErrors.join('\n'));
}
assert(consoleErrors.length === 0, `unexpected console errors: ${consoleErrors.join(' | ')}`);
assert(pageErrors.length === 0, `unexpected page errors: ${pageErrors.join(' | ')}`);

console.log('\nATELIER + REDINI v3 E2E: ALL OK');
await browser.close();
