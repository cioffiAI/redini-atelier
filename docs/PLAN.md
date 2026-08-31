# OPERATIONAL PLAN — 5 days to the deadline
Submission deadline: **September 3, 2026, 22:00 Italian time** (13:00 PDT)
Judging: September 4-21 · Winners: ~September 23

---

## 1. Day-by-day plan (SOLO variant)

~8-10 hours/day of effective work. Every day has a verifiable "done" criterion.

### Day 1 — 29/08: foundations + spike (THE most important day)
- [x] Vite + TS scaffold with a green build, GitHub repo `cioffiAI/redini-atelier` (private, publish on day 4) with MIT LICENSE, src/ structure (redini/ + atelier/), spike tool `list_templates` already registered in the code
- [x] Project documents: CONCEPT, TECHNICAL-DESIGN, PLAN, SPIKE
- [x] SPIKE run on headless Chrome 149 (results in docs/SPIKE.md): pipeline OK, promise alive >90s, JSON-string signature of executeTool, schema synthesis, dynamic tools, AbortController
- [x] Go decision: blocking approval with a pending promise; day 2 builds the ChangeSet

**Done when**: a tool actually runs in the browser with WebMCP, spike table filled in.

### Day 2 — 30/08: the core (redini library, transactional semantics) — COMPLETED
- [x] `registerChangeSetTool()` / `registerSafeTool()`: one intent → one tool call → one ChangeSet
- [x] First-class ChangeSet: `ChangeSet {operations[], stateVersion, status, proposedAt, committedAt}` with lifecycle `proposed → reviewing → committed | declined | cancelled | stale | failed (+ undone | undo_failed)`
- [x] Individually addressable operations: validated amend (per-op, `INVALID_AMENDMENT` without mutation), toggle/cherry-pick, atomic commit of the subset
- [x] **Deterministic undo/redo via inverse operations** (limited vocabulary, exact inverse per op; NO snapshot store); editor-style history `undoStack`/`redoStack`: the entry moves to the redo stack ONLY on a complete replay, every new commit invalidates the redo
- [x] Structured-row receipt: intended / amended / skippedByHuman / applied (values actually committed)
- [x] Stale guard: internal mutation counter + optional `getStateVersion` → `STALE_TRANSACTION`
- [x] Provenance / audit trail (kind, txId, humanEdited, rolledBack TRUTHFUL)
- [x] 14/14 test gate passed (`npm test`, vitest), including: decline without execute, atomic rollback without a false receipt, failed rollback → `ROLLBACK_FAILED`, exact undo, deterministic double-undo, failed undo that does NOT move the entry (stays on the undo stack, retry-safe), two concurrent transactions, AbortSignal → `cancelled` with UI notify, WebMCP promise closed only after the decision
- [x] API that always emits a structured outcome directly to the agent (committed/declined_by_user/cancelled/stale_transaction/execute_failed): the changeset execute NEVER rejects

**Done**: the paths (commit / amend+commit / skip / rejection / rollback / undo / abort) produce coherent receipts in the audit trail (verified in unit tests).

### Day 3 — 31/08: Atelier (the app) — COMPLETED
- [x] Complete flyer canvas (title, subtitle, date, colors, fonts, logo) + 4 mock templates with vendor notes
- [x] **Exactly 5 tools registered via Redini: 1 changeset (`design_update`) + 4 safe (list_templates, get_current_design, filter_templates, get_vendor_content)**: FIXED surface, no dynamic tools
- [x] `design_update` with strict per-kind inputSchema (enum, required, additionalProperties:false) + consistent validator
- [x] Ghost preview: staged proposals are seen on the canvas BEFORE they happen (visual differentiator); cleared on the terminal outcome of its ChangeSet
- [x] Typed per-kind amend forms (text / color+hex / real font select / x,y with canvas bound / size)
- [x] Adversarial case: get_vendor_content (untrustedContentHint) with injection in the evening-gala template
- [x] Direct human actions (template click) also go through a ChangeSet (dispatch+immediate commit) → complete audit
- [x] 29/29 tests (19 core + 10 atelier) + REAL browser e2e (`scripts/atelier-e2e.mjs` via document.modelContext.executeTool): pending until the decision → amend UI → skip → commit → receipt → undo → decline, zero console errors

**Done when**: complete flow demonstrable: intent → ChangeSet → negotiation → commit of the subset → receipt → undo.

### Day 4 — 01/09: solidity + repo — COMPLETED (release-hardening v3)
- [x] Redini v3 hardening: validated amendment + recalculated label, `cancelled` abort visible, undo/redo history lifecycle (undoStack/redoStack), truthful rollback reporting, direct execution result (no envelope), strict schema, removal of variants (surface fixed at 5)
- [x] README.md (Atelier primary / Redini secondary, flow, honest "How this differs", scoped atomicity claim, how to run, ?clean=1 / ?debug=1)
- [x] Code cleanup: safe DOM (no dynamic innerHTML), CSS with no dead blocks, v3 docs, `npm run build` with no errors
- [x] History/UI pass (commit 45ee190): complete editor-style undo/redo in the panel (buttons + keyboard ⌘Z / ⇧⌘Z / Ctrl+Y, never on text inputs), redo invalidated by every new commit
- [x] Final micro-hardening (post-45ee190): failed commit → sweep of the pending ones (immediate isStale even without getStateVersion), `getHistory()` as an isolated DTO (structuredClone), actor provenance (human proposals never "Agent proposed"), templates as semantic `<button>`, Commit disabled at 0 operations, undo/redo docs synchronized
- [ ] Public repo: license visible in About, curated description

**Done when**: a stranger clones the repo, follows the README, and gets everything running.

### Day 5 — 02/09: video + submission (MARGIN: 3/09 is left only for emergencies)
- [ ] Video script (< 3 min, ONE continuous scenario, the golden path): request ("make the poster more minimal") → the agent proposes ONE 3-operation ChangeSet via WebMCP → the human amends one (typed amend), excludes one (cherry-pick), commits the subset → 4-section receipt (INTENDED / AMENDED BY HUMAN / SKIPPED BY HUMAN / APPLIED) → the agent receives the structured response and continues → deterministic undo in one click (20s) → reusable library claim (20s)
- [ ] Recording with clear audio (screen + voice), no copyrighted music
- [ ] Public YouTube upload
- [ ] Submission text in English (4 points required by the rules)
- [ ] Submit on Devpost

**Done when**: submission sent with 24h of margin.

## 2. Definition of Done (submission ready)

- [ ] Live URL working in a browser with WebMCP (final test on the day of submission)
- [ ] Public repo, MIT, complete README, fresh-clone works
- [ ] Public YouTube video < 3 min with audio
- [ ] Submission text in English on the 4 points of the rules
- [ ] Site accessible for free and without restrictions until September 21
- [ ] Submit done by 22:00 on September 3 (target: September 2)

## 3. Rules of engagement (to be respected without exception)

1. No new features after August 31. From September 1 it is polish only.
2. Every evening: commit + push to main; the Netlify deploy is always the state of the art.
3. If a spike test fails, apply the planned fallback; do not rewrite the strategy on day 3.
4. The video is recorded on September 2, not September 3.
