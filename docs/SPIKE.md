# SPIKE — Pre-build verification (Day 1)
Goal: verify on REAL GROUND that the WebMCP pipeline behaves as expected, BEFORE writing the product. Every test has a binary outcome and an already-designed fallback (TECHNICAL-DESIGN §6).

---

## 0. Prerequisites (USER ACTION, ~20 minutes)

| # | Action | Verification |
|---|---|---|
| 0.1 | Install **ChatGPT Desktop** from https://chatgpt.com/download | The app opens and logs in |
| 0.2 | Install **Google Chrome**. Version **149+** is required: downloadable from google.com/chrome. If stable is <149, use Chrome Beta/Canary | Open chrome://version and note the version |
| 0.3 | In Chrome: open `chrome://flags/#enable-webmcp-testing` → **Enabled** → Restart | The flag is present and enabled |
| 0.4 | Deploy the scaffold to **Netlify**: npm run build → drag the `dist/` folder onto https://app.netlify.com/drop (or connect the GitHub repo from app.netlify.com) | Public URL https://…netlify.app responds |

> **Status 29/08 afternoon**: 0.1 and 0.2 DONE (ChatGPT installed+logged in; user confirms Chrome with the MCP testing flag enabled). 0.4 still to do.
> The 6 tests do NOT require temporary code: all the test tools (slow_tool, test_booking form, add_note, temp_echo) are already in the app (commit `spike tools`).
> The localhost environment is already running: `npm run dev` runs on http://localhost:5173 (started in the background, log in /tmp/vite-dev.log).

## 1. How to run the tests

In each test browser (ChatGPT in-app browser and Chrome+flag):
1. Open the site URL (Netlify or localhost)
2. Verify that the badge at the top says "WebMCP available" (green)
3. In the agent's conversation panel, type the prompt indicated by the test
4. Record the outcome in the §3 table

## 2. The tests, in order of priority

### Test 1 — Base pipeline (BLOCKING)
**Prompt to the agent**: `List the available flyer templates` (and then: `list only spring themed templates`)
**Expected**: the agent sees the `list_templates` tool, calls it, receives the templates JSON and answers in natural language listing them; with the spring filter, it answers with Spring Market only.
**If it fails in both browsers**: STOP. Reassess the strategy (day 1, not day 4).

### Test 2 — Tool timeout while waiting on a human (THE most important test for Redini)
Setup: temporarily add a `slow_tool` in main.ts whose execute waits on a manually resolved promise (e.g. exposed on window: `window.resolveSlow()`), so it does NOT resolve on its own.
**Prompt**: `Call the slow tool and tell me what it returns`
**Expected**: the tool call stays pending; after 60+ seconds call `window.resolveSlow('done')` from the console and verify that the agent receives the result.
**To record**: how long does the browser keep the promise alive? Is there a timeout? What error reaches the agent if it expires?
- If ALIVE BEYOND 2 MINUTES → the blocking approval flow is OK: Redini can wait for the user inside execute()
- If SHORT TIMEOUT (<60s) → implement immediate `pending_user_approval` ack + response on the next turn

### Test 3 — Declarative form (form filled by the agent)
Setup: temporarily add a test form to index.html:
```html
<form toolname="test_booking" tooldescription="Books a table for testing" id="test-form">
  <input name="guest_name" toolparamdescription="Name of the guest" required>
  <input name="people" type="number" toolparamdescription="Number of people" required>
  <button type="submit">Book</button>
</form>
```
**Prompt**: `Book a table for 4 people under the name Rossi`
**Expected**: the agent fills the form fields (without toolautosubmit, the submit stays manual); the form is visually filled.
**To record**: does the fill happen? Are the fields visibly filled? Does the agent say to wait for the human submit?
- If OK → we proceed with the declarative checkout form (Day 3)
- If KO → fallback F1 (imperative tool `fill_checkout_form` that fills the fields via JS, same review UX)

### Test 4 — SubmitEvent.agentInvoked + respondWith
Setup: add a listener to the Test 3 form:
```js
document.getElementById('test-form').addEventListener('submit', (e) => {
  if (e.agentInvoked) { e.preventDefault(); e.respondWith(Promise.resolve({ status: 'booked' })); }
});
```
**Prompt**: repeat Test 3 and then ask the agent to submit (`...and submit it`)
**Expected**: the agent presses submit (or requests it), the listener intercepts, the page does NOT navigate, the agent receives `{status:'booked'}`.
- If OK → checkout with structured confirmation to the agent (Day 3)
- If KO → fallback F2 (`get_order_status`)

### Test 5 — dynamic tools and toolchange
Setup: register an `add_note` tool in main.ts that in turn registers `get_note_N` via a dedicated controller + toolchange listener.
**Prompt**: `Add a note saying "hello"` then `Read my note`
**Expected**: after add_note, the agent sees and calls get_note_N.
- If OK → the dynamic design variants (Day 3). **SUPERSEDED in v3**: no variants, the surface is fixed at 5 tools (see historical note below)
- If KO → the tools stay static; the variants are returned as data in the result of create_variant. **SUPERSEDED in v3**: this path is abandoned too (create_variant does not exist in v3)

### Test 6 — Deregistration via AbortController
Setup: tool `temp_echo` registered with a signal; a tool `dispose_temp` that calls controller.abort().
**Prompt**: `Call temp echo with "hi"` → expected: it works. `Call dispose temp` then again `call temp echo` → expected: the tool no longer exists.
- If OK → clean exit of the variants (Day 3). The "variants" part is **SUPERSEDED in v3** (no variants); deregistration via AbortController stays in v3 for the safe tools

**Historical note (v3)**: the "forward-looking" plans below (declarative checkout form, `fill_checkout_form`, `get_order_status`, `respondWith` for orders) have been **SUPERSEDED**: v3 has no checkout and no orders, the product is ChangeSet negotiation (see CONCEPT/TECHNICAL-DESIGN v3). Test 3/4 had value only as a technical verification of `agentInvoked`/`respondWith`; the product decisions that derived from them were abandoned in favor of the `design_update` changeset tool.

## 3. Results table (to be filled in)

| Test | ChatGPT in-app browser | Chrome 149+ flag | Decision |
|---|---|---|---|
| 1 Base pipeline | ☐ (to do with a real agent) | ✅ PASS (automated) | — |
| 2 Timeout human wait (duration?) | ☐ | ✅ promise alive >90s, resolved on resolve | ☑ blocking approval |
| 3 Declarative form filled | ☐ | ✅ fields filled + tool pending | ☑ declarative |
| 4 respondWith | ☐ | ✅ human submit closes the tool with `{status:'booked'}`; `agentInvoked:true` | ☑ structured confirmation |
| 5 dynamic tools + toolchange | ☐ | ✅ read_note_1 registered + 1 event | ☑ dynamic variants, **SUPERSEDED in v3** (surface fixed at 5 tools) |
| 6 AbortController | ☐ | ✅ temp_echo removed | ☑ clean deregistration |

Signature note (verified in v3): `executeTool(registeredTool, args)` requires (1) the **RegisteredTool object returned by `getTools()`** as the first argument and (2) **args as a JSON STRING** (objects → "Failed to parse input arguments"); the response arrives serialized as a JSON string. Historical script: `scripts/spike-auto.mjs` (removed, see the note at the top). Remaining: repeat the tests with ChatGPT's in-app browser (real agent, ~10 min, prompts already ready above).

The MINIMUM starting bar is Test 1 on at least one of the two browsers. Everything else has a fallback.

## 4. Spike output

1. §3 table filled in (both columns)
2. Decision on: blocking approval vs pending ack; declarative vs F1
3. These decisions change ONLY the Day 2-3 implementation, not the plan
