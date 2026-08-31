# Atelier — an agent-native design studio, powered by Redini

**Live demo:** https://redini-atelier.netlify.app

**Atelier** is a WebMCP design editor where agent actions arrive as **editable ChangeSets** rather than silent mutations. One agent intent can produce multiple proposed operations. Before application state changes, the person can **preview the proposal, amend individual parameters, skip individual operations** and **commit the accepted subset**.

**Redini** is the small transaction layer underneath.

## The flow

```
agent intent
      ↓
ONE WebMCP call (design_update)   ← one intent → one ChangeSet
      ↓
ChangeSet — e.g. 3 operations

  [✓] setText title → "Ghost Title"
  [✓] setFill background → #224466
  [✓] move logo → (40, 40)

      ↓
preview (ghost on the canvas) → amend parameters → skip operations (cherry-pick)
      ↓
atomic commit of the accepted subset
      ↓
RECEIPT — INTENDED / AMENDED BY YOU / SKIPPED BY YOU / APPLIED · STATE v→v
      ↓
Undo ↔ Redo (deterministic — inverse operations, editor-style history:
           undoStack/redoStack, and a new commit invalidates the redo future)
```

Undo/redo is one keyboard shortcut away: **⌘/Ctrl+Z** undoes, **⇧⌘/Ctrl+Z** (or **Ctrl+Y**) redoes — the app never hijacks undo inside text inputs.

Nothing touches application state until the human commits. The agent's `executeTool` call stays **pending** for the whole negotiation and resolves with a direct structured result: `{status, changeSetId, appliedCount, amendedCount, skippedCount, undoAvailable}` — it never dies, never throws an unhandled rejection.

Example receipt (what the panel renders after a commit):

```
INTENDED — 3 proposed by the agent        Title · "Ghost Title"
                                          Background · #224466
                                          Logo position · 40, 40

AMENDED BY YOU — 1 changed by you         Title · "Ghost Title" → "Amended Title"

SKIPPED BY YOU — 1 excluded               Background · #224466

APPLIED — 2 committed                     ✓ Title · "Amended Title"
                                          ✓ Logo position · 40, 40

State v0 → v2
▸ Developer details (receipt id, tool, intent, operation ids, timestamps) — collapsed
```

## The 5 tools

| Tool | Mode | What it does |
|---|---|---|
| `design_update` | changeset | ONE intent + operations array → editable ChangeSet, strict per-kind inputSchema |
| `list_templates` | safe | Lists the flyer templates (id, name, style tags) |
| `get_current_design` | safe | Current flyer design state, read-only |
| `filter_templates` | safe | Filters templates by a style description |
| `get_vendor_content` | safe | Untrusted vendor promo copy — `untrustedContentHint` set |

Operation vocabulary (each with an exact inverse): `setText`, `setFill`, `setFont`, `move`, `resize`. The tool surface is **fixed**: no dynamic tools are ever registered.

## How this differs

Approval gates exist (allow/deny modals, platform confirmations), diff/undo editors exist, and WebMCP confirmations exist. We know — the honest comparison:

- **Platform confirmations / approval gates** answer yes/no to a prepared action. Atelier's ChangeSet is **editable per operation**: the human changes parameters of individual operations before anything commits, and can skip individual operations (cherry-pick) — the subset is what commits.
- **Diff/undo editors** show a before/after of one change. Redini stages **multiple proposed operations from one agent intent** inside **ONE live WebMCP invocation** and keeps the agent's promise pending until the human decides; the receipt records the distance between what the agent intended and what the human co-authored.
- **Undo**: deterministic **inverse operations** per applied operation (limited vocabulary, exact undo), not generic snapshots.

**Atomicity** — Atelier applies its deterministic local operation subset atomically using compensating inverse operations. If an apply is attempted and does not complete, the resulting state may be partially applied — Redini reports the result as state-uncertain instead of claiming nothing happened. No universal claims beyond that: Redini runs in the page, it is human control, recoverability and auditable mutations — not a security boundary. The scoped atomicity claim above stays true for Atelier: its store emit is failure-isolated, so an apply can never break after the mutation.

## How to run

```bash
npm install
npm run dev        # dev server → http://localhost:5173
npm test           # vitest unit tests
npm run build      # tsc && vite build
node scripts/atelier-e2e.mjs   # real WebMCP e2e (needs dev server + Chrome)
```

WebMCP needs a supporting browser: Chrome 149+ launched with
`--enable-features=WebMCP`, or a WebMCP-capable in-app browser (e.g. ChatGPT's).

### URL parameters

- `?clean=1` — hides the human-facing hint text. Agent-side mutation still happens only through the `design_update` ChangeSet tool; the template gallery remains a human path, and it also goes through a ChangeSet.
- `?debug=1` — exposes `window.__guard` in the console for interactive debugging. The e2e does **not** use it.

## Deploy

```bash
npm run build        # tsc && vite build → dist/
```

Publish the **`dist/` folder** — Netlify Drop (drag & drop at app.netlify.com/drop) works as-is, because Vite copies `public/_headers` verbatim into `dist/_headers`. Those headers make the WebMCP browser setup explicit and set the baseline security posture:

- `Origin-Agent-Cluster: ?1` — WebMCP requires the document to live in an **origin-keyed agent cluster**.
- `Permissions-Policy: tools=(self)` — the experimental `tools()` permission is exposed to this origin only.
- `X-Content-Type-Options: nosniff` — MIME sniffing is disabled.
- `Referrer-Policy: strict-origin-when-cross-origin` — referrer leakage stays minimal.
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://chat.openai.com` — same-origin resources only (the app links local CSS/JS, uses system fonts and CSSOM styling, and makes no external fetches), plus the anti-clickjacking policy: `frame-ancestors` allowlists `'self'` and the ChatGPT WebMCP hosts, so the human approval surface is protected against framing except for allowlisted WebMCP hosts; if a future host needs embedding, extend the allowlist.

Repository-connected deploys are covered by [`netlify.toml`](./netlify.toml) (build `npm run build`, publish `dist`). Post-deploy verification in the browser console:

```js
await document.modelContext.getTools(); // → the 5 tools
window.originAgentCluster;              // → true
```

### E2E troubleshooting

- If `node scripts/atelier-e2e.mjs` cannot find Chrome: adjust `CHROME` at the top of the script.
- Stale Chrome profile: `pkill -f "user-data-dir=/tmp/atelier-chrome-profile"` before rerunning.
- Dev server down: `nohup npm run dev > /tmp/vite-dev.log 2>&1 &`.

## Repository layout

- `src/atelier/` — the demo app: design store (pure logic), tools, UI.
- `src/redini/` — the transaction layer: guard, ChangeSet model, DOM panel, in-memory UI adapter. Application-agnostic: it knows nothing about flyers.
- `docs/` — concept, technical design (v3 semantics), plan, spike report.

## License

MIT — see [LICENSE](./LICENSE).
