# TECHNICAL DESIGN — Redini + Atelier (v3)
Stato: v3 — 30/08/2026+ — la unità centrale è il **ChangeSet multi-operazione**
(una intent → un tool call → una transazione editabile). Documenta TUTTE le
semantiche v3: amendment validato, receipt a righe strutturate, lifecycle
dell'undo token, EXECUTION_FAILED vs ROLLBACK_FAILED, execute-che-non-rifiuta,
schema strict per-kind.

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
UNDO deterministico (inverse operations, token monouso)
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
  undoToken: string;
  proposedAt: number;
  committedAt: number;
}
```

Rendering nel pannello:

```
INTENDED                 → label originali dell'agente
AMENDED BY HUMAN         → "label corrente (was: label originale)"
SKIPPED BY HUMAN         → label correnti delle op escluse
APPLIED (committed values) → label correnti delle op applicate, nell'ordine
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

**Caso speciale EMPTY_CHANGESET**: committare un ChangeSet tutto-skippato è un errore
della UI umana, NON dell'agente: la promessa NON viene sbloccata, il ChangeSet resta
`reviewing` (l'umano può re-includere), l'errore viene rilanciato solo al chiamante UI.

## 7. Undo token lifecycle

`undo(undoToken)`:

- Replay degli inversi in ordine inverso DENTRO try/catch, tracciando il
  progresso reale (`done`: gli id degli inversi effettivamente riusciti).
- Il token è marcato `consumed` SOLO dopo che TUTTI gli inversi sono riusciti.
- Se un inverso fallisce: il token NON viene consumato, stato `undo_failed`,
  audit `undo_failed` con detail TRUTHFUL — mai l'elenco totale:
  - `attempted` = `[...done, <id dell'inverso fallito>]` (ciò che è stato
    davvero provato, nell'ordine di replay),
  - `remaining` = id degli inversi NON ancora rieseguiti (quelli dopo il
    fallimento),
  - `cause` = messaggio dell'errore sottostante.
  Il messaggio del RediniError deriva da `done.length` ("failed after N
  successful compensations"); il bundle viaggia in `detail` e l'errore reale
  in `cause`: `RediniError('UNDO_FAILED', msg, cause, detail)`.
- Nota di design: gli inversi hanno semantica set (idempotente) — quelli di Atelier la rispettano (ogni inverso imposta un valore concreto), quindi riprovare un undo fallito con lo stesso token è sicuro.
- Successo: stato `undone`, audit `rolled_back`, `ui.onUndo`, bump del mutation counter.

**Limite noto**: le mappe `changeSets` e `undoRecords` non vengono potate — la
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

- `setText` → params `{field: enum[title,subtitle,dateLine], value: string}`
- `setFill` → params `{target: enum[background,text], value: string pattern ^#[0-9a-fA-F]{6}$}`
- `setFont` → params `{value: string enum dei 3 font reali}`
- `move` → params `{x: number 0..640, y: number 0..400}` (bound reali della canvas)
- `resize` → params `{size: number 16..200}`

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
  (`.tx-card`, `.tx-chip` per stato incluso cancelled/undo_failed, `.tx-intent`,
  `.tx-op`, `.op-mark`, `.op-label`, `.op-amended`, `.op-edit-btn`, form di edit,
  `.tx-commit/.tx-decline`, `.tx-error`, `.receipt`, `.receipt-pre`).
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

## 12. Caso avversario (demo beat, non paper di security)

Il tool read-only `get_vendor_content` restituisce testo promozionale del
template "evening-gala" con un'istruzione iniettata. Punto dimostrato: la
mutazione resta una proposta in staging — con diff visibile sul ghost — e non
diventa mai automaticamente stato dell'app. L'umano la rifiuta con un click.
Nessuna pretesa di security boundary: il layer è client-side, è human control
e recoverability.

## 13. Struttura del repository

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
