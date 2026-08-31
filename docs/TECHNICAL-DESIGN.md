# TECHNICAL DESIGN — Redini + Atelier (v3)
Stato: v3 — 30/08/2026+ — la unità centrale è il **ChangeSet multi-operazione**
(una intent → un tool call → una transazione editabile). Documenta TUTTE le
semantiche v3: amendment validato (con contratto contestuale `validate(op, priorOps?)`),
receipt a righe strutturate, history editor-style (undoStack/redoStack),
EXECUTION_FAILED vs ROLLBACK_FAILED, stateUncertain (atomicità onesta), emit
failure-isolated di Atelier, execute-che-non-rifiuta, cap DoS (size caps),
schema strict per-kind, header di sicurezza.

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
- `cancelled` on either AbortSignal: the WebMCP **invocation** being aborted (`detail.reason: 'agent_aborted'`), or the tool's **registration** being aborted, which unregisters it and retracts every proposal still open on it (`detail.reason: 'tool_unregistered'`). Both are a visible TERMINAL outcome; the UI receives `emitUpdate` and the agent's promise unblocks exactly once with `status: 'cancelled'`. Removing a tool never leaves a pending ChangeSet behind: an orphan would read committable while `commitChangeSet` could only throw `UNKNOWN_TOOL`, stranding the agent's promise forever.
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

### Contratto di validazione CONTESTUALE: `validate(op, priorOps?)`

Il validatore riceve, oltre all'operazione candidata, il **contesto sequenziale**: `validate?: (op, priorOps?) => string | null`, dove `priorOps` è l'array delle operazioni che la precedono — params CORRENTI (eventuali amendment), in ordine di proposta. Il guard lo fornisce in entrambi i punti di ingresso:

- **dispatch**: le raw operations già validate fin lì (stessa sequenza che il commit applicherà);
- **amendOperation**: le ops PRIOR **incluse** (slice prima dell'op modificata, filtrata per `included`), così un amendment umano viene validato sullo STESSO stato derivato del commit.

Il contratto è generico e application-agnostic; i validatori esistenti che ignorano il secondo argomento restano pienamente compatibili.

Il guard esegue `validate` in TRE punti di ingresso: **dispatch**, **amendOperation** e **commit** (commit-time chain re-validation). A commit, OGNI op inclusa viene ri-validata sullo stesso contesto accumulato prior-included che il commit applicherà: skip e amend possono cambiare lo stato derivato DOPO la validazione per-op (skippare un resize precedente fa committare un move successivo sulla size LIVE; un parametro amendato può spingere l'op successiva fuori bounds). Se una ri-validazione fallisce → `INVALID_OPERATION` PRIMA di qualsiasi mutazione, senza sbloccare la promessa dell'agente e senza cambiare lo stato del ChangeSet (resta `reviewing` — l'umano può amendare/skippare e riprovare, stessa semantica di EMPTY_CHANGESET). La validazione a dispatch resta feedback anticipato; la catena inclusa viene ri-validata a commit perché è lì che decide.

### Regola derived-fit del logo (Atelier)

Il bug corretto: `move` accettava `x<=640/y<=400` a prescindere dalla SIZE del logo, quindi `move {x:640,y:400}` portava il logo interamente fuori canvas — e un `resize` successivo nello stesso ChangeSet poteva invalidare un move prima valido. La regola corretta `x + size <= CANVAS_W && y + size <= CANVAS_H` è valutata sullo **stato derivato sequenziale**: `validateOp(op, priorOps)` ripercorre il logo `{x, y, size}` partendo da `store.design.logo` (move imposta x/y, resize imposta size) e valida il candidato: move → x/y candidati con size derivata; resize → size candidata con x/y derivati. Fuori bounds → `"logo would not fit inside the canvas at (x, y) with size N"` (`INVALID_OPERATION` al dispatch, `INVALID_AMENDMENT` all'amend). Le descrizioni dello schema move/resize documentano la regola.

La UI usa form tipizzati per-kind (niente editing JSON grezzo):
`setText` → input testo; `setFill` → color picker + hex; `setFont` → select con i font reali dell'app; `move` → x/y numerici con i bound reali della canvas (640×400); `resize` → size numerico (16–200). Un errore `INVALID_AMENDMENT` appare inline in `.tx-error` e il form resta aperto.

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

### stateUncertain: atomicità ONESTA

**EXECUTION_FAILED è SEMPRE state-uncertain per costruzione**: quando un commit
fallisce, `ChangeSet.stateUncertain` e `AgentOutcome.stateUncertain` vengono
impostati a `true` in OGNI esito (EXECUTION_FAILED e ROLLBACK_FAILED).
Razionale: un apply è stato **tentato e NON ha completato** — Redini non può
sapere se il runtime ha mutato lo stato prima di lanciare (nessun inverso
restituito) — quindi lo stato risultante **potrebbe essere parzialmente
applicato**; Redini riporta `stateUncertain` invece di dichiarare "non è
successo niente", anche quando il prefisso completato viene compensato
pulitamente. (La vecchia condizione `applyAttempts > appliedIds.length` era
una tautologia: un apply che lancia è SEMPRE stato tentato senza completare.)

Il flag viaggia nel public ChangeSet (solo quando true), nel detail dell'audit
`failed` e in ENTRAMBI gli esiti di settle (`EXECUTION_FAILED` e
`ROLLBACK_FAILED`). La UI umanizza in modo coerente — activity line, nota
terminale della card, errore inline del commit e canvas status: un
EXECUTION_FAILED è SEMPRE "A change couldn't be fully applied — the poster may
be in a partially updated state." (la copy ROLLBACK_FAILED "Some changes could
not be fully restored." resta invariata). Mai una falsa asserzione "niente è
stato committato" quando un apply è stato tentato.

### emit failure-isolated (Atelier)

`AtelierStore.emit()` avvolge OGNI listener in try/catch (console.warn, mai rethrow). Razionale: `apply()` legge prev → muta via mutator del store (che emette) → costruisce l'inverso; un listener UI che lancia DOPO la mutazione romperebbe la failure-atomicity. Con l'isolamento gli apply di Atelier sono failure-atomic in pratica — l'unico lavoro post-mutazione è costruire l'inverso, puro. L'assunzione core di Redini NON cambia: per i runtime generici il flag `stateUncertain` resta la rete di sicurezza.

**Caso speciale EMPTY_CHANGESET**: committare un ChangeSet tutto-skippato è un errore
della UI umana, NON dell'agente: la promessa NON viene sbloccata, il ChangeSet resta
`reviewing` (l'umano può re-includere), l'errore viene rilanciato solo al chiamante UI.

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

- `setText` → params `{field: enum[title,subtitle,dateLine], value: string maxLength 120}`
- `setFill` → params `{target: enum[background,text], value: string pattern ^#[0-9a-fA-F]{6}$}`
- `setFont` → params `{value: string enum dei 3 font reali, maxLength 120}`
- `move` → params `{x: number 0..640, y: number 0..400}` (bound reali della canvas) — regola derived-fit in §3
- `resize` → params `{size: number 16..200}` — regola derived-fit in §3

### Cap DoS (size caps)

Il ChangeSet è limitato a **32 operations** e **200 caratteri di intent**; i valori di `setText`/`setFont` a **120 caratteri**. Applicazione DOPPIA, mai solo schema:

- **Schema** (`inputSchema` di `design_update`): `maxItems: 32`, `maxLength: 200` su intent, `maxLength: 120` sui value — con descrizioni che notano la regola derived-fit per move/resize;
- **Runtime** (mai fidarsi dell'enforcement dello schema host): il guard rifiuta `operations > 32` → `"too many operations (max 32)"` e `intent > 200` → `"intent too long (max 200 characters)"` (entrambi `INVALID_OPERATION` al dispatch); `validateOp` rifiuta il 33° op contando `priorOps` e i value > 120 → `"value too long (max 120 characters)"`.

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

## 14. Header di sicurezza (anti-clickjacking + posture baseline)

`public/_headers` (copiato verbatim in `dist/_headers` da Vite):

```
/*
  Origin-Agent-Cluster: ?1
  Permissions-Policy: tools=(self)
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://chat.openai.com
```

- La CSP è UNA riga nel file. `default-src 'self'` + `script-src/style-src/connect-src 'self'` e `img-src 'self' data:` coprono l'app senza origini esterne: build con CSS/JS locali, font di sistema, manipolazione stile via CSSOM (non bloccata da `style-src`), favicon `data:,`, nessun fetch esterno.
- **frame-ancestors** usa un ALLOWLIST (`'self'` + host ChatGPT WebMCP) e NON `'none'` di proposito: il browser host WebMCP può incorporare l'app; la superficie di approvazione umana è protetta dal framing eccetto gli host allowlistati. Se un futuro host deve incorporarla, si estende la lista. (Il lead farà un re-smoke post-deploy e toglierà la riga se incompatibile.)
- L'e2e gira su localhost SENZA gli header Netlify: la verifica delle intestazioni reali è post-deploy; a livello di CI si asserisce il contenuto di `dist/_headers` dopo la build (`grep -q "Origin-Agent-Cluster" dist/_headers` in `.github/workflows/ci.yml`) — la copia verbatim di `public/_headers` non può più andare alla deriva.

## 15. Caso avversario (demo beat, non paper di security)

The read-only tool `get_vendor_content` returns promotional text for the
"evening-gala" template with an injected instruction. Point demonstrated: the
mutation stays a staged proposal (with a visible diff on the ghost) and never
automatically becomes app state. The human rejects it with one click.
No claim of a security boundary: the layer is client-side, it is human control
and recoverability.

## 16. Struttura del repository

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
