# TECHNICAL DESIGN — Redini + Atelier (v3)
Status: v3, 30/08/2026+. The central unit is the **multi-operation ChangeSet**
(one intent → one tool call → one editable transaction). Documents ALL the
v3 semantics: validated amendment, structured-row receipt, editor-style history
(undoStack/redoStack), EXECUTION_FAILED vs ROLLBACK_FAILED,
execute-that-never-rejects,
strict per-kind schema.

---

## 1. General architecture

```
┌─────────────────────────────────────────────────────┐
│  Atelier (demo app)                                 │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Design       │  │ Guardrail UI (Redini panel)  │ │
│  │ Canvas +     │  │ - ChangeSet cards            │ │
│  │ ghost prev.  │  │ - Receipts (4 sections)      │ │
│  │ + state      │  │ - Activity log / undo        │ │
│  └──────┬───────┘  └──────────────┬───────────────┘ │
│         │                         │                 │
│  ┌──────┴─────────────────────────┴───────────────┐ │
│  │ redini/ (library, application-agnostic)        │ │
│  │  - ChangeSet model + guard                     │ │
│  │  - inverse-operation undo (no snapshots)       │ │
│  │  - dom-panel (optional UI adapter)             │ │
│  └──────────────────┬─────────────────────────────┘ │
└─────────────────────┼───────────────────────────────┘
                      │
        document.modelContext  (native WebMCP API)
                      │
              Browser agent (Chrome --enable-features=WebMCP /
              ChatGPT in-app browser)
```

Three layers with clean responsibilities:
- **Atelier**: UI, domain (flyer design), tool registration.
- **redini/**: ChangeSet, validation, atomic commit, undo, receipt. Zero domain knowledge (no "flyer" in `src/redini`).
- **native WebMCP**: registration, discovery, execution.

## 2. Model: the ChangeSet

**Invariant**: ONE agent intent → ONE WebMCP call (`design_update`) → ONE ChangeSet.

```
Agent intent
      ↓
executeTool('design_update', {...})   ← the promise STAYS PENDING
      ↓
ChangeSet: operations[]  (id, kind, label, params, originalParams, originalLabel, included, amended)
      ↓
the human: amend (validated) | toggle (cherry-pick) | commit subset | decline
      ↓
COMMIT → 4-section receipt → structured response direct to the agent
      ↓
deterministic UNDO/REDO (editor-style history: undoStack/redoStack, inverse operations)
```

### ChangeSet state

`proposed → reviewing → committed | declined | cancelled | stale | failed | undone | undo_failed`

- `proposed` just staged; `reviewing` after the first human interaction (amend/toggle).
- `cancelled` when the WebMCP invocation is aborted (AbortSignal): it is a visible TERMINAL outcome; the UI receives `emitUpdate`, the agent's promise unblocks exactly once with `status: 'cancelled'`.
- `stale` when the app state changed between the proposal and the commit (see §5).
- `failed` when the commit fails halfway (with rollback attempted, §6).
- `undo_failed` when the replay of the inverses fails (§7).
- Terminal outcomes: `committed, declined, cancelled, stale, failed, undone, undo_failed` → the card becomes a read-only chip, with no live checkbox/button.

## 3. Validated amendment + recalculated label

`amendOperation(csId, opId, params)`:

1. Rejects non-plain-object params with `INVALID_AMENDMENT`.
2. Runs the registered tool's `validate` on `{kind, params}`: if it returns an error string → `RediniError INVALID_AMENDMENT` with that message and **the operation is NOT mutated**.
3. On success: `op.params = structuredClone(params)` and `op.label` **recalculated** via `describeOperation` with the NEW params (panel and receipt always show the current description).
4. `originalParams` (and `originalLabel`, fixed at dispatch) stay immutable forever: they are the proof of the agent's intention.

The UI uses typed per-kind forms (no raw JSON editing):
`setText` → text input; `setFill` → color picker + hex; `setFont` → select with the app's real fonts; `move` → numeric x/y with the canvas's real bounds (640×400); `resize` → numeric size (16–200). An `INVALID_AMENDMENT` error appears inline in `.tx-error` and the form stays open.

## 4. Structured receipt (4 sections)

```ts
interface ReceiptRow {
  id: string;
  kind: string;
  label: string;            // description of the row's CURRENT VALUE
  originalLabel?: string;   // agent's original description (amended rows)
  params: Record<string, unknown>;
  originalParams?: Record<string, unknown>; // agent's value (amended rows)
}

interface ChangeSetReceipt {
  transactionId: string;
  changeSetId: string;   // alias
  tool: string;
  intent: string;
  intended: ReceiptRow[];        // original label + original params
  amended: ReceiptRow[];         // BOTH originalParams (agent) and params (human)
  skippedByHuman: ReceiptRow[];  // current label/params
  applied: ReceiptRow[];         // VALUES ACTUALLY COMMITTED (current params+label)
  stateVersionBefore: number;
  stateVersionAfter: number;
  proposedAt: number;
  committedAt: number;
}
```

(The receipt carries no undo token: the undo is editor-style via
`undoStack`/`redoStack` (§7). The emitted receipt stays the app-facing object; the
copy ARCHIVED in the
`HistoryEntry` is a `structuredClone`, so a mutation by the app
cannot corrupt the history.)

Rendering in the panel:

```
INTENDED                 → agent's original rows (original label + params)
AMENDED BY YOU           → "before → after" for each operation changed by the human
SKIPPED BY YOU           → current rows of the excluded ops
APPLIED                  → rows with the VALUES ACTUALLY COMMITTED (✓ for each op)
FOOTER                   → "State vN → vM"
DEV DETAILS              → structured sections (receipt, tool, intent, id, dates)
```

The distance intention → result is the heart of the product: SKIPPED NEVER appears in APPLIED; the amended rows keep both values.

The receipt stays visible even on error outcomes (`failed` / `undo_failed`):
precisely when something went wrong the human must see what had been
applied. The block is rendered for EVERY terminal state of the card
(committed, undone, failed, undo_failed, …), never for proposed/reviewing.

## 5. Stale guard

Double counter: Redini's internal mutation counter + the app's `getStateVersion()`
(Atelier: `store.version`, bumped by EVERY mutation). If at commit time
`mutationIndex !== mutationCounter` or the app version changed →
`STALE_TRANSACTION`: nothing is applied, the card becomes `stale`, the agent's
promise unblocks with `status: 'stale_transaction'` + `error.code: 'STALE_TRANSACTION'`.

## 6. Atomic commit with TRUTHFUL rollback reporting

The commit applies the included ops in order; each `apply` returns the inverse.
If an `apply` fails:

1. The inverses already collected are re-run in reverse order, **counting the real successes** (`compensated`).
2. If ALL inverses succeed: state `failed`, audit `failed {error, rolledBack: <real successes>}`, agent promise → `execute_failed` with `error.code: EXECUTION_FAILED`, thrown to the UI caller `RediniError('EXECUTION_FAILED', msg, cause)`.
3. If ONE inverse fails: stop, state `failed`, audit `failed {error, rolledBack: <successes so far>, rollbackFailed: true, failedCompensation: <id>}`, agent promise → `execute_failed` with `error.code: ROLLBACK_FAILED`, thrown `RediniError('ROLLBACK_FAILED', ..., {appliedOperations, compensatedOperations, failedCompensation, cause})`. **No false rolledBack count.**
4. The agent's promise is unblocked EXACTLY ONCE on all paths.
5. Redini **does not assume apply is failure-atomic**. Every `runtime.apply` attempted in a failed commit/undo/redo conservatively invalidates the pending proposals (bump of the `mutationCounter`), regardless of whether an inverse was returned (an apply can mutate state and throw WITHOUT returning the inverse).

**Special case EMPTY_CHANGESET**: committing an all-skipped ChangeSet is a human-UI
error, NOT an agent error: the promise is NOT unblocked, the ChangeSet stays
`reviewing` (the human can re-include), the error is re-thrown only to the UI caller.

## 7. Editor-style history: undo stack / redo stack

`undo()` / `redo()` (no single-use token, v3 history):

- `undo()`: replay of the inverses of the entry on top of `undoStack`
  (`entry.inverseOperations` is ALREADY in reverse order of application) INSIDE a
  try/catch, tracking the real progress (`done`: the ids of the inverses
  that actually succeeded).
- The entry is moved to `redoStack` ONLY after ALL inverses have
  succeeded. If one inverse fails: the entry STAYS on `undoStack`, state
  `undo_failed`, audit `undo_failed` with a TRUTHFUL detail, never the full list:
  - `attempted` = `[...done, <id of the failed inverse>]` (what was
    really attempted, in replay order),
  - `remaining` = ids of the inverses NOT yet re-run (those after the
    failure),
  - `cause` = message of the underlying error.
  The RediniError message derives from `done.length` ("failed after N
  successful compensations"); the bundle travels in `detail` and the real error
  in `cause`: `RediniError('UNDO_FAILED', msg, cause, detail)`.
- `redo()`: reapplies the STORED `forwardOperations` (the NEGOTIATED set, amended
  params and labels) in application order, capturing FRESH inverses:
  the entry that returns to `undoStack` carries the exact inverses of the redo. On
  failure the entry STAYS on `redoStack`, the ChangeSet stays `undone`, audit
  `redo_failed` with the same TRUTHFUL bundle (`attempted`/`remaining`/`cause`),
  and a retry converges (forward set-semantics).
- Design note: inverses and forward have set semantics (idempotent), Atelier's
  respect this (each op sets a concrete value), so
  retrying a failed undo/redo is safe.
- Undo success: state `undone`, audit `undone {operations: <n inverses>}`,
  `ui.onUndo`, bump of the mutation counter. Redo success: state `committed`
  (even if the cs had stayed `undo_failed`), audit `redone {applied: <n>}`,
  `ui.onRedo`, bump of the counter. A NEW commit empties the redo stack (the
  future undone is invalidated).
- The FAILURE paths of undo/redo apply partial mutations (the state version
  advances): the guard immediately calls `sweepPendingPreviews()` so the
  pending ChangeSets are re-emitted with `isStale` and updated previews: no
  lying ghosts/cards waiting for the next event.

**Known limit**: the `changeSets` maps and the stacks are not pruned; the
memory grows with the number of transactions. Acceptable and intentional for
short demo sessions (bounded); no pruning in v3.

## 8. The changeset execute NEVER rejects (direct result)

The `execute` callback registered in WebMCP for `design_update`:

```
try { return await dispatch(...) } catch (e) { return { status:'execute_failed', error:{code,message} } }
```

- No `{content:[{type:'text',...}]}` envelope: the result is the direct serializable object
  `{status, changeSetId, appliedCount, amendedCount, skippedCount, undoAvailable, error?}`.
- Pre-staging validation errors (unknown tool / invalid operations) → resolve with `status:'execute_failed'` + `error.code: INVALID_OPERATION`, instead of rejecting.
- Mid-commit errors → `EXECUTION_FAILED` / `ROLLBACK_FAILED` in the same `error.code` field.
- EMPTY_CHANGESET stays pending (see §6).
- Safe tools continue to return raw objects.

## 9. Strict schema of design_update (FIX H)

`design_update` provides an explicit `inputSchema` that Redini registers VERBATIM
(the generic loose default is only the fallback for tools without a schema):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["intent", "operations"],
  "properties": {
    "operations": {
      "type": "array", "minItems": 1,
      "items": { "oneOf": [ /* one entry per kind, each:
        { "type":"object", "additionalProperties":false, "required":["kind","params"],
          "kind": {"enum": ["setText"]},
          "params": { "additionalProperties": false, "required": ["field", "value"],
                      "field": {"enum":["title","subtitle","dateLine"]}, ... } } */ ] }
    }
  }
}
```

- `setText` → params `{field: enum[title,subtitle,dateLine], value: string}`
- `setFill` → params `{target: enum[background,text], value: string pattern ^#[0-9a-fA-F]{6}$}`
- `setFont` → params `{value: string enum of the 3 real fonts}`
- `move` → params `{x: number 0..640, y: number 0..400}` (canvas's real bounds)
- `resize` → params `{size: number 16..200}`

`def.validate` (validateOp) is CONSISTENT with the schema, and the parity is now
complete at the guard dispatch level: unknown kinds, wrong enums, missing/mistyped
fields and **extra keys in params** → all
`INVALID_OPERATION` at dispatch (and `INVALID_AMENDMENT` at amend). Plus:
move/resize require real NUMBERs (a string `"40"` is rejected, never
coerced), extra keys at the OPERATION level (beyond `kind`/`params`) are
rejected (additionalProperties:false), and a missing `intent` is `INVALID_OPERATION`.
The guard no longer applies the "(no intent given)" default.

## 10. Safe DOM and CSS

- No innerHTML with interpolation of dynamic values in `src/`: all the
  UI uses `createElement`/`textContent`; `innerHTML = ''` only as a clear.
- The stylesheet lives in `src/styles.css`: dead blocks removed (spike zone,
  playground, old orders form, variants), duplicates merged, new styles for the live negotiation
  (`.tx-card`, `.tx-chip` for state including cancelled/undo_failed, `.tx-op`,
  `.op-heading`, `.op-value`, `.op-amended-badge`, `.op-skipped-badge`,
  `.op-edit-btn`, `.tx-edit-form`, `.tx-commit/.tx-decline`, `.tx-error`,
  `.receipt` with structured sections, `.dev-details`).
- The ghost preview (proposal on the canvas before commit) stays: it is painted
  by the ChangeSet that proposed it and cleared when THAT one reaches a
  terminal outcome.

## 11. Inventory of Atelier's tools (v3 — exactly 5, fixed)

| Tool | Mode | Purpose |
|---|---|---|
| `design_update` | changeset | intent + operations → ChangeSet (strict schema) |
| `list_templates` | safe | Template list |
| `get_current_design` | safe | Current flyer state |
| `filter_templates` | safe | Filter by description |
| `get_vendor_content` | safe | Untrusted vendor content (untrustedContentHint) |

No dynamic tools: no variants, no `select_variant_N`. The surface
is verified by test (fix 5 tools after any flow).

## 12. Adversarial case (demo beat, not a security paper)

The read-only tool `get_vendor_content` returns promotional text for the
"evening-gala" template with an injected instruction. Point demonstrated: the
mutation stays a staged proposal (with a visible diff on the ghost) and never
automatically becomes app state. The human rejects it with one click.
No claim of a security boundary: the layer is client-side, it is human control
and recoverability.

## 13. Repository structure

```
webmcp-hackaton/
├─ LICENSE / netlify.toml
├─ README.md
├─ docs/                    # these documents
├─ src/
│  ├─ redini/               # library (self-contained, copyable elsewhere)
│  │  ├─ index.ts, guard.ts, types.ts, errors.ts, utils.ts
│  │  └─ ui/ (dom-panel.ts, in-memory.ts)
│  ├─ atelier/              # demo app
│  │  ├─ store.ts, tools.ts, templates.ts, ui.ts
│  └─ styles.css
├─ scripts/atelier-e2e.mjs   # the only e2e runner (real WebMCP)
├─ tests/ (redini.core.test.ts, atelier.test.ts)
├─ index.html
└─ package.json / vite.config.ts / tsconfig.json
```
