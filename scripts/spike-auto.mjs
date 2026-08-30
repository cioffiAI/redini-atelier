/**
 * Automated WebMCP spike runner.
 * Drives the locally-installed Chrome (with WebMCP feature flags) against the
 * dev server, simulating an in-page agent via the official
 * getTools()/executeTool() API, and reports results.
 *
 * Usage: node scripts/spike-auto.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5173/';
const results = [];
const log = (test, ok, detail) => {
  results.push({ test, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${test}  —  ${detail}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Try flag variants until document.modelContext appears.
const flagVariants = [
  ['--enable-webmcp-testing'],
  ['--enable-features=WebMCP'],
  ['--enable-blink-features=WebMCP'],
];

let browser = null;
let workingFlags = null;

for (const flags of flagVariants) {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [...flags, '--no-first-run', '--disable-extensions', '--user-data-dir=/tmp/spike-chrome-profile'],
  });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2' });
  const has = await page.evaluate(() => !!document.modelContext);
  await page.close();
  if (has) {
    workingFlags = flags;
    break;
  }
  await browser.close();
  browser = null;
}

if (!browser) {
  console.log('FAIL  API presence  —  document.modelContext never appeared in headless. Retrying headful with the primary flag...');
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: ['--enable-webmcp-testing', '--no-first-run', '--user-data-dir=/tmp/spike-chrome-profile'],
    protocolTimeout: 300000,
  });
}

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
await page.goto(URL, { waitUntil: 'networkidle2' });

// ---- T1a: API presence + badge ----
const badge = await page.$eval('#webmcp-status', (el) => `${el.textContent} [${el.className}]`);
log('T1a API presence', true, `modelContext exists; badge="${badge}"; flags=${workingFlags ?? 'headful fallback'}`);

// Wait for the page bootstrap to finish registering tools.
await sleep(1500);

// ---- T1b: discovery ----
const toolNames = await page.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name),
);
log(
  'T1b tool discovery (getTools)',
  toolNames.includes('list_templates') && toolNames.includes('slow_tool') && toolNames.includes('test_booking'),
  `tools: ${toolNames.join(', ')}`,
);

// ---- T1c: execute read-only tool — probe call shapes ----
const listProbe = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools();
  const t = tools.find((x) => x.name === 'list_templates');
  const shapes = [
    ['JSON-string args', () => document.modelContext.executeTool(t, JSON.stringify({ style: 'spring' }))],
    ['tool-object + args', () => document.modelContext.executeTool(t, { style: 'spring' })],
  ];
  const out = [];
  for (const [label, fn] of shapes) {
    try {
      const r = await fn();
      out.push({ label, ok: true, result: JSON.stringify(r).slice(0, 100) });
    } catch (e) {
      out.push({ label, ok: false, error: `${e.name}: ${e.message}` });
    }
  }
  return out;
});
const workingShape = listProbe.find((s) => s.ok && s.result.includes('spring-market') && !s.result.includes('yard-sale'));
log(
  'T1c executeTool (read-only + filter)',
  !!workingShape,
  workingShape ? `shape "${workingShape.label}" → ${workingShape.result}` : `all shapes failed: ${JSON.stringify(listProbe)}`,
);

// ---- T3a: declarative form schema synthesis ----
const formSchema = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools();
  const t = tools.find((x) => x.name === 'test_booking');
  return t ? JSON.stringify(t.inputSchema) : null;
});
log(
  'T3a declarative form registered + schema synthesized',
  !!formSchema && formSchema.includes('guest_name') && formSchema.includes('people'),
  formSchema ?? 'test_booking NOT exposed via getTools',
);

// ---- T2: pending-promise lifetime (THE decision test) ----
await page.evaluate(async () => {
  const tools = await document.modelContext.getTools();
  const t = tools.find((x) => x.name === 'slow_tool');
  window.__slowDone = false;
  window.__slowCallShape = null;
  window.__slowError = null;
  const attempts = [
    ['JSON-string args', () => document.modelContext.executeTool(t, JSON.stringify({}))],
    ['tool-object + args', () => document.modelContext.executeTool(t, {})],
  ];
  for (const [label, fn] of attempts) {
    try {
      fn()
        .then((r) => {
          window.__slowResult = r;
          window.__slowDone = true;
        })
        .catch((e) => {
          window.__slowError = `${e.name}: ${e.message}`;
          window.__slowDone = true;
        });
      window.__slowCallShape = label;
      break;
    } catch (e) {
      window.__slowError = `${e.name}: ${e.message}`;
    }
  }
});
const t0 = Date.now();
await sleep(30000);
const alive30 = await page.evaluate(() => !window.__slowDone);
await sleep(60000);
const alive90 = await page.evaluate(() => !window.__slowDone);
await page.evaluate(() => window.resolveSlow('late-human-approval'));
await sleep(2000);
const slowState = await page.evaluate(() => ({
  done: window.__slowDone,
  result: JSON.stringify(window.__slowResult ?? null),
  error: window.__slowError,
  shape: window.__slowCallShape,
}));
const t2Ok = alive30 && alive90 && slowState.done && slowState.result.includes('late-human-approval');
log(
  'T2 pending-promise lifetime',
  t2Ok,
  `shape="${slowState.shape}" pending@30s=${alive30} pending@90s=${alive90} resolved: ${slowState.result?.slice(0, 80)}${slowState.error ? ' ERROR: ' + slowState.error : ''} (wall time ${Math.round((Date.now() - t0) / 1000)}s)`,
);

// ---- T5: dynamic registration + toolchange ----
const t5 = await page.evaluate(async () => {
  let changes = 0;
  document.modelContext.addEventListener('toolchange', () => {
    changes += 1;
  });
  const tools = await document.modelContext.getTools();
  const addNote = tools.find((x) => x.name === 'add_note');
  let addRes = null;
  let addError = null;
  try {
    addRes = JSON.stringify(await document.modelContext.executeTool(addNote, JSON.stringify({ text: 'hello world' }))).slice(0, 100);
  } catch (e) {
    addError = `${e.name}: ${e.message}`;
  }
  await new Promise((r) => setTimeout(r, 800));
  const names = (await document.modelContext.getTools()).map((t) => t.name);
  const readTool = names.find((n) => n.startsWith('read_note_'));
  let readRes = null;
  if (readTool) {
    const rt = (await document.modelContext.getTools()).find((x) => x.name === readTool);
    readRes = JSON.stringify(await document.modelContext.executeTool(rt, JSON.stringify({})));
  }
  return { addRes, addError, readTool, readRes, changes };
});
log(
  'T5 dynamic tool + toolchange',
  !!t5.readTool && t5.readRes?.includes('hello world') && t5.changes > 0,
  `registered "${t5.readTool}", read back: ${t5.readRes}, toolchange events: ${t5.changes}${t5.addError ? ' ADD ERROR: ' + t5.addError : ''}`,
);

// ---- T6: unregistration via AbortController ----
const t6 = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools();
  const dispose = tools.find((x) => x.name === 'dispose_temp');
  let disposeError = null;
  try {
    await document.modelContext.executeTool(dispose, JSON.stringify({}));
  } catch (e) {
    disposeError = `${e.name}: ${e.message}`;
  }
  await new Promise((r) => setTimeout(r, 800));
  const names = (await document.modelContext.getTools()).map((t) => t.name);
  return { names, gone: !names.includes('temp_echo'), disposeError };
});
log('T6 unregistration via AbortController', t6.gone, `temp_echo removed: ${t6.gone}${t6.disposeError ? ' DISPOSE ERROR: ' + t6.disposeError : ''}`);

// ---- T3b/T4: declarative form — agent fills, tool stays pending, human submit completes it ----
await page.evaluate(async () => {
  const tools = await document.modelContext.getTools();
  const t = tools.find((x) => x.name === 'test_booking');
  window.__bookingState = { resolved: false, result: null, error: null };
  document.modelContext
    .executeTool(t, JSON.stringify({ guest_name: 'Auto Bot', people: 2 }))
    .then((r) => {
      window.__bookingState.resolved = true;
      window.__bookingState.result = JSON.stringify(r);
    })
    .catch((e) => {
      window.__bookingState.resolved = true;
      window.__bookingState.error = `${e.name}: ${e.message}`;
    });
});
await sleep(3000);
const fillState = await page.evaluate(() => ({
  guest: document.querySelector('#test-form input[name="guest_name"]')?.value ?? null,
  people: document.querySelector('#test-form input[name="people"]')?.value ?? null,
  pending: !window.__bookingState.resolved,
  log: [...document.querySelectorAll('#activity-log li')].map((li) => li.textContent).join(' | '),
}));
log(
  'T3b form filled by agent, tool pending human review',
  fillState.guest === 'Auto Bot' && fillState.people === '2' && fillState.pending,
  `guest="${fillState.guest}" people="${fillState.people}" stillPending=${fillState.pending}${fillState.log ? ' | log: ' + fillState.log.slice(0, 100) : ''}`,
);

// the "human" reviews and submits
await page.evaluate(() => {
  const form = document.getElementById('test-form');
  form?.querySelector('button[type="submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
});
await sleep(2500);
const after = await page.evaluate(() => ({
  ...window.__bookingState,
  log: [...document.querySelectorAll('#activity-log li')].map((li) => li.textContent).join(' | '),
}));
log(
  'T4 human submit completes the agent tool call',
  after.resolved === true && (after.result ?? '').includes('booked'),
  `resolved=${after.resolved} result=${(after.result ?? after.error ?? 'null').slice(0, 110)} | log: ${after.log.slice(0, 140)}`,
);

// ---- console errors ----
log('Console errors', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(' | ').slice(0, 200) : 'none');

console.log('\n=== SUMMARY ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.test}`);
await browser.close();
