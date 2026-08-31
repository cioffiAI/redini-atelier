# TECHNICAL DESIGN — Redini + Atelier (v3)
Stato: v3 — 30/08/2026+ — la unità centrale è il **ChangeSet multi-operazione**
(una intent → un tool call → una transazione editabile). Documenta TUTTE le
semantiche v3: amendment validato (con contratto contestuale `validate(op, priorOps?)`),
receipt a righe strutturate, history editor-style (undoStack/redoStack),
EXECUTION_FAILED vs ROLLBACK_FAILED, stateUncertain (atomicità onesta), emit
failure-isolated di Atelier, execute-che-non-rifiuta, cap DoS (size caps),
schema strict per-kind, header di sicurezza.

---

## 1. Architettura generale

```
┌─────────────────────────────────────────────────────┐
│  Atelier (app demo)                                 │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Design       │  │ Guardrail UI (Redini panel)  │ │
│  │ Canvas +     │  │ - ChangeSet cards            │ │
│  │ ghost prev.  │  │ - Receipts (4 sezioni)       │ │
│  │ + stato      │  │ - Activity log / undo        │ │
│  └──────┬───────┘  └──────────────┬───────────────┘ │
│         │                         │                 │
│  ┌──────┴─────────────────────────┴───────────────┐ │
│  │ redini/ (libreria, application-agnostic)       │ │
│  │  - ChangeSet model + guard                     │ │
│  │  - inverse-operation undo (no snapshots)       │ │
│  │  - dom-panel (UI adapter opzionale)            │ │
│  └──────────────────┬─────────────────────────────┘ │
└─────────────────────┼───────────────────────────────┘
                      │
        document.modelContext  (API WebMCP nativa)
                      │
              Browser agent (Chrome --enable-features=WebMCP /
              ChatGPT in-app browser)
```

Tre strati con responsabilità nette:
- **Atelier**: UI, dominio (design del flyer), registrazione dei tool.
- **redini/**: ChangeSet, validazione, commit atomico, undo, receipt. Zero conoscenza del dominio (nessun "flyer" in `src/redini`).
- **WebMCP nativo**: registrazione, discovery, esecuzione.

## 2. Modello: il ChangeSet

**Invariante**: ONE agent intent → ONE WebMCP call (`design_update`) → ONE ChangeSet.

```
Agent intent
      ↓
executeTool('design_update', {...})   ← la promessa RESTA PENDING
      ↓
ChangeSet: operations[]  (id, kind, label, params, originalParams, originalLabel, included, amended)
      ↓
l'umano: amend (validato) | toggle (cherry-pick) | commit subset | decline
      ↓
COMMIT → receipt 4 sezioni → risposta strutturata diretta all'agente
      ↓
UNDO/REDO deterministici (history editor-style: undoStack/redoStack, inverse operations)
```

### Stato del ChangeSet

`proposed → reviewing → committed | declined | cancelled | stale | failed | undone | undo_failed`

- `proposed` appena staged; `reviewing` dopo la prima interazione umana (amend/toggle).
- `cancelled` quando la invocazione WebMCP viene abortita (AbortSignal): è un esito TERMINALE visibile — la UI riceve `emitUpdate`, la promessa dell'agente si sblocca una sola volta con `status: 'cancelled'`.
- `stale` quando lo stato dell'app è cambiato tra la proposta e il commit (guarda §5).
- `failed` quando il commit fallisce a metà (con rollback tentato, §6).
- `undo_failed` quando il replay degli inversi fallisce (§7).
- Esiti terminali: `committed, declined, cancelled, stale, failed, undone, undo_failed` → la card diventa un chip read-only, senza checkbox/button live.

## 3. Amendment validato + label ricalcolata

`amendOperation(csId, opId, params)`:

1. Rifiuta parametri non-plain-object con `INVALID_AMENDMENT`.
2. Esegue il `validate` del tool registrato su `{kind, params}`: se restituisce una stringa di errore → `RediniError INVALID_AMENDMENT` con quel messaggio e **l'operazione NON viene mutata**.
3. A successo: `op.params = structuredClone(params)` e `op.label` **ricalcolato** via `describeOperation` con i NUOVI parametri (pannello e receipt mostrano sempre la descrizione corrente).
4. `originalParams` (e `originalLabel`, fissato al dispatch) restano immutabili per sempre — sono la prova dell'intenzione dell'agente.

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

## 4. Receipt strutturata (4 sezioni)

```ts
interface ReceiptRow {
  id: string;
  kind: string;
  label: string;            // descrizione del VALORE CORRENTE della riga
  originalLabel?: string;   // descrizione originale dell'agente (righe amended)
  params: Record<string, unknown>;
  originalParams?: Record<string, unknown>; // valore dell'agente (righe amended)
}

interface ChangeSetReceipt {
  transactionId: string;
  changeSetId: string;   // alias
  tool: string;
  intent: string;
  intended: ReceiptRow[];        // label originale + params originali
  amended: ReceiptRow[];         // BOTH originalParams (agent) e params (human)
  skippedByHuman: ReceiptRow[];  // label/params correnti
  applied: ReceiptRow[];         // VALORI REALMENTE COMMITTATI (params+label correnti)
  stateVersionBefore: number;
  stateVersionAfter: number;
  proposedAt: number;
  committedAt: number;
}
```

(La receipt non porta alcun token di undo: l'undo è editor-style via
`undoStack`/`redoStack` — §7. La receipt emessa resta l'oggetto app-facing; la
copia ARCHIVIATA nella
`HistoryEntry` è un `structuredClone`, così una mutazione da parte dell'app
non può corrompere la storia.)

Rendering nel pannello:

```
INTENDED                 → righe originali dell'agente (label + params originali)
AMENDED BY YOU           → "prima → dopo" per ogni operazione cambiata dall'umano
SKIPPED BY YOU           → righe correnti delle op escluse
APPLIED                  → righe coi VALORI REALMENTE COMMITTATI (✓ per ogni op)
FOOTER                   → "State vN → vM"
DEV DETAILS              → sezioni strutturate (ricevuta, tool, intent, id, date)
```

La distanza intenzione → risultato è il cuore del prodotto: SKIPPED non appare MAI in APPLIED; le righe amended conservano entrambi i valori.

La receipt resta visibile anche sugli esiti di errore (`failed` / `undo_failed`):
proprio quando qualcosa è andato storto l'umano deve vedere cosa era stato
applicato. Il blocco viene renderizzato per OGNI stato terminale della card
(committed, undone, failed, undo_failed, …), mai per proposed/reviewing.

## 5. Stale guard

Doppio contatore: mutation counter interno di Redini + `getStateVersion()` dell'app
(Atelier: `store.version`, bumpato da OGNI mutazione). Se alla commit
`mutationIndex !== mutationCounter` oppure la versione dell'app è cambiata →
`STALE_TRANSACTION`: nulla viene applicato, la card diventa `stale`, la promessa
dell'agente si sblocca con `status: 'stale_transaction'` + `error.code: 'STALE_TRANSACTION'`.

## 6. Commit atomico con reporting TRUTHFUL del rollback

Il commit applica le op incluse in ordine; ogni `apply` restituisce l'inverso.
Se un `apply` fallisce:

1. Gli inversi già raccolti vengono rieseguiti in ordine inverso, **contando i successi reali** (`compensated`).
2. Se TUTTI gli inversi riescono: stato `failed`, audit `failed {error, rolledBack: <successi reali>}`, promessa agente → `execute_failed` con `error.code: EXECUTION_FAILED`, lanciato al chiamante UI `RediniError('EXECUTION_FAILED', msg, cause)`.
3. Se UN inverso fallisce: ferma, stato `failed`, audit `failed {error, rolledBack: <successi finora>, rollbackFailed: true, failedCompensation: <id>}`, promessa agente → `execute_failed` con `error.code: ROLLBACK_FAILED`, lanciato `RediniError('ROLLBACK_FAILED', ..., {appliedOperations, compensatedOperations, failedCompensation, cause})`. **Nessun falso conteggio rolledBack.**
4. La promessa dell'agente viene sbloccata ESATTAMENTE UNA volta in tutti i percorsi.
5. MELD: Redini **non assume apply failure-atomic** — ogni `runtime.apply` tentato in un commit/undo/redo fallito invalida conservativamente le proposte pending (bump del `mutationCounter`), a prescindere dal fatto che un inverso sia stato restituito (un apply può mutare lo stato e lanciare SENZA restituire l'inverso).

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

## 7. History editor-style: undo stack / redo stack

`undo()` / `redo()` (nessun token monouso — v3 history):

- `undo()`: replay degli inversi dell'entry in cima a `undoStack`
  (`entry.inverseOperations` è GIÀ in ordine inverso di applicazione) DENTRO
  try/catch, tracciando il progresso reale (`done`: gli id degli inversi
  effettivamente riusciti).
- L'entry viene spostata su `redoStack` SOLO dopo che TUTTI gli inversi sono
  riusciti. Se un inverso fallisce: l'entry RESTA su `undoStack`, stato
  `undo_failed`, audit `undo_failed` con detail TRUTHFUL — mai l'elenco totale:
  - `attempted` = `[...done, <id dell'inverso fallito>]` (ciò che è stato
    davvero provato, nell'ordine di replay),
  - `remaining` = id degli inversi NON ancora rieseguiti (quelli dopo il
    fallimento),
  - `cause` = messaggio dell'errore sottostante.
  Il messaggio del RediniError deriva da `done.length` ("failed after N
  successful compensations"); il bundle viaggia in `detail` e l'errore reale
  in `cause`: `RediniError('UNDO_FAILED', msg, cause, detail)`.
- `redo()`: riapplica le `forwardOperations` STORED (il set NEGOZIATO — params
  e label amendati) in ordine di applicazione, catturando inversi FRESCHI:
  l'entry che torna su `undoStack` porta gli inversi esatti della redo. Su
  failure l'entry RESTA su `redoStack`, il ChangeSet resta `undone`, audit
  `redo_failed` con lo stesso bundle TRUTHFUL (`attempted`/`remaining`/`cause`),
  e un retry converge (forward set-semantics).
- Nota di design: inversi e forward hanno semantica set (idempotente) — quelli
  di Atelier la rispettano (ogni op imposta un valore concreto), quindi
  riprovare un undo/redo fallito è sicuro.
- Successo undo: stato `undone`, audit `undone {operations: <n inversi>}`,
  `ui.onUndo`, bump del mutation counter. Successo redo: stato `committed`
  (anche se il cs era rimasto `undo_failed`), audit `redone {applied: <n>}`,
  `ui.onRedo`, bump del counter. Un NUOVO commit svuota il redo stack (il
  futuro undone è invalidato).
- I percorsi di FAILURE di undo/redo applicano mutazioni parziali (la versione
  dello stato avanza): il guard chiama subito `sweepPendingPreviews()` così i
  ChangeSet pending vengono ri-emessi con `isStale` e preview aggiornati — niente
  ghost/card menzogneri in attesa del prossimo evento.

**Limite noto**: le mappe `changeSets` e gli stack non vengono potati — la
memoria cresce con il numero di transazioni. Accettabile e intenzionale per
sessioni demo brevi (bounded); nessun pruning in v3.

## 8. L'execute del changeset NON rifiuta mai (risultato diretto)

Il callback `execute` registrato in WebMCP per `design_update`:

```
try { return await dispatch(...) } catch (e) { return { status:'execute_failed', error:{code,message} } }
```

- Niente envelope `{content:[{type:'text',...}]}`: il risultato è l'oggetto diretto serializzabile
  `{status, changeSetId, appliedCount, amendedCount, skippedCount, undoAvailable, error?}`.
- Errori di validazione pre-staging (tool sconosciuto / operazioni invalide) → risolvono con `status:'execute_failed'` + `error.code: INVALID_OPERATION`, invece di rifiutare.
- Errori mid-commit → `EXECUTION_FAILED` / `ROLLBACK_FAILED` nello stesso campo `error.code`.
- EMPTY_CHANGESET resta pending (vedi §6).
- I tool safe continuano a restituire oggetti raw.

## 9. Schema strict di design_update (FIX H)

`design_update` fornisce un `inputSchema` esplicito che Redini registra VERBATIM
(il default generico loose è solo il fallback per tool senza schema):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["intent", "operations"],
  "properties": {
    "operations": {
      "type": "array", "minItems": 1,
      "items": { "oneOf": [ /* una voce per kind, ognuna:
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

`def.validate` (validateOp) è CONSISTENTE con lo schema — e la parità è ora
completa a livello di guard dispatch: kind sconosciuti, enum errati, campi
mancanti/tipizzati male e **chiavi extra nei params** → tutti
`INVALID_OPERATION` al dispatch (e `INVALID_AMENDMENT` all'amend). In più:
move/resize richiedono NUMBER reali (una stringa `"40"` è rifiutata, mai
coercita), le chiavi extra a livello OPERATION (oltre `kind`/`params`) sono
rifiutate (additionalProperties:false), e `intent` mancante è `INVALID_OPERATION`
— il guard non applica più il default "(no intent given)".

## 10. Safe DOM e CSS

- Nessun innerHTML con interpolazione di valori dinamici in `src/`: tutta la
  UI usa `createElement`/`textContent`; `innerHTML = ''` solo come clear.
- Lo stylesheet vive in `src/styles.css`: blocchi morti rimossi (spike zone,
  playground, vecchio form ordini, varianti), duplicati fusi, stili nuovi per la negoziazione live
  (`.tx-card`, `.tx-chip` per stato incluso cancelled/undo_failed, `.tx-op`,
  `.op-heading`, `.op-value`, `.op-amended-badge`, `.op-skipped-badge`,
  `.op-edit-btn`, `.tx-edit-form`, `.tx-commit/.tx-decline`, `.tx-error`,
  `.receipt` con sezioni strutturate, `.dev-details`).
- Il ghost preview (proposta sul canvas prima del commit) resta: viene dipinto
  dal ChangeSet che lo ha proposto e cancellato quando QUELLO raggiunge un esito
  terminale.

## 11. Inventario dei tool di Atelier (v3 — esattamente 5, fissi)

| Tool | Mode | Scopo |
|---|---|---|
| `design_update` | changeset | intent + operations → ChangeSet (schema strict) |
| `list_templates` | safe | Elenco template |
| `get_current_design` | safe | Stato corrente del flyer |
| `filter_templates` | safe | Filtro per descrizione |
| `get_vendor_content` | safe | Contenuto vendor non affidabile (untrustedContentHint) |

Nessun tool dinamico: niente varianti, niente `select_variant_N`. La superficie
è verificata a test (fix 5 tool dopo qualsiasi flusso).

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

Il tool read-only `get_vendor_content` restituisce testo promozionale del
template "evening-gala" con un'istruzione iniettata. Punto dimostrato: la
mutazione resta una proposta in staging — con diff visibile sul ghost — e non
diventa mai automaticamente stato dell'app. L'umano la rifiuta con un click.
Nessuna pretesa di security boundary: il layer è client-side, è human control
e recoverability.

## 16. Struttura del repository

```
webmcp-hackaton/
├─ LICENSE / netlify.toml
├─ README.md
├─ docs/                    # questi documenti
├─ src/
│  ├─ redini/               # libreria (autocontenuta, copiabile altrove)
│  │  ├─ index.ts, guard.ts, types.ts, errors.ts, utils.ts
│  │  └─ ui/ (dom-panel.ts, in-memory.ts)
│  ├─ atelier/              # app demo
│  │  ├─ store.ts, tools.ts, templates.ts, ui.ts
│  └─ styles.css
├─ scripts/atelier-e2e.mjs   # l'unico runner e2e (WebMCP reale)
├─ tests/ (redini.core.test.ts, atelier.test.ts)
├─ index.html
└─ package.json / vite.config.ts / tsconfig.json
```
