# PIANO OPERATIVO — 5 giorni alla deadline
Deadline submission: **3 settembre 2026, 22:00 ora italiana** (13:00 PDT)
Judging: 4-21 settembre · Vincitori: ~23 settembre

---

## 1. Piano giorno per giorno (variante SOLO)

~8-10 ore/giorno di lavoro effettivo. Ogni giorno ha un criterio di "fatto" verificabile.

### Giorno 1 — 29/08: fondamenta + spike (IL giorno più importante)
- [x] Scaffold Vite + TS con build verde, repo GitHub `cioffiAI/redini-atelier` (privato, pubblica il giorno 4) con LICENZA MIT, struttura src/ (redini/ + atelier/), tool spike `list_templates` già registrato nel codice
- [x] Documenti di progetto: CONCEPT, TECHNICAL-DESIGN, PLAN, SPIKE
- [x] SPIKE eseguito su Chrome 149 headless (esiti in docs/SPIKE.md): pipeline OK, promessa viva >90s, firma JSON-string di executeTool, schema synthesis, tool dinamici, AbortController
- [x] Decisione Go: approvazione bloccante con promessa pending; il giorno 2 costruisce il ChangeSet

**Fatto quando**: un tool gira davvero nel browser con WebMCP, tabella spike compilata.

### Giorno 2 — 30/08: il cuore (libreria redini, semantica transazionale) — COMPLETATO
- [x] `registerChangeSetTool()` / `registerSafeTool()` — una intent → un tool call → un ChangeSet
- [x] ChangeSet first-class: `ChangeSet {operations[], stateVersion, status, proposedAt, committedAt}` con lifecycle `proposed → reviewing → committed | declined | cancelled | stale | failed (+ undone | undo_failed)`
- [x] Operazioni indirizzabili singolarmente: amend valdato (per-op, `INVALID_AMENDMENT` senza mutazione), toggle/cherry-pick, commit atomico del subset
- [x] **Undo/redo deterministici via inverse operations** (vocabolario limitato, inverso esatto per op; NIENTE snapshot store); history editor-style `undoStack`/`redoStack`: l'entry si sposta sul redo stack SOLO a replay completo, ogni nuovo commit invalida il redo
- [x] Receipt a righe strutturate: intended / amended / skippedByHuman / applied (valori realmente committati)
- [x] Stale guard: contatore mutazioni interno + `getStateVersion` opzionale → `STALE_TRANSACTION`
- [x] Provenance / audit trail (kind, txId, humanEdited, rolledBack TRUTHFUL)
- [x] 14/14 test gate passati (`npm test`, vitest) — inclusi: decline senza execute, rollback atomico senza false receipt, rollback fallito → `ROLLBACK_FAILED`, undo esatto, double-undo deterministico, undo fallito che NON sposta l'entry (resta sull'undo stack, retry-safe), due transazioni concorrenti, AbortSignal → `cancelled` con notify UI, promessa WebMCP chiusa solo dopo decisione
- [x] API che emette sempre outcome strutturato diretto all'agente (committed/declined_by_user/cancelled/stale_transaction/execute_failed) — l'execute del changeset NON rifiuta mai

**Fatto**: le vie (commit / amend+commit / skip / rifiuto / rollback / undo / abort) producono receipt coerenti nell'audit trail — verificato in unit test.

### Giorno 3 — 31/08: Atelier (l'app) — COMPLETATO
- [x] Canvas flyer completo (titolo, sottotitolo, data, colori, font, logo) + 4 template mock con note vendor
- [x] **Esattamente 5 tool registrati via Redini: 1 changeset (`design_update`) + 4 safe (list_templates, get_current_design, filter_templates, get_vendor_content)** — superficie FISSA, nessun tool dinamico
- [x] `design_update` con inputSchema strict per-kind (enum, required, additionalProperties:false) + validator consistente
- [x] Ghost preview: le proposte in staging si vedono sul canvas PRIMA di accadere (differenziatore visivo); cancellato dall'esito terminale del suo ChangeSet
- [x] Form di amend tipizzati per-kind (text / color+hex / select font reali / x,y con bound canvas / size)
- [x] Caso avversario: get_vendor_content (untrustedContentHint) con iniezione nel template evening-gala
- [x] Azioni umane dirette (click template) passano anch'esse da ChangeSet (dispatch+commit immediato) → audit completo
- [x] 29/29 test (19 core + 10 atelier) + e2e browser REALE (`scripts/atelier-e2e.mjs` via document.modelContext.executeTool): pending fino alla decisione → amend UI → skip → commit → receipt → undo → decline, zero errori console

**Fatto quando**: flusso completo dimostrabile: intent → ChangeSet → negoziazione → commit del subset → receipt → undo.

### Giorno 4 — 01/09: solidità + repo — COMPLETATO (release-hardening v3)
- [x] Redini v3 hardening: amendment validato + label ricalcolata, abort `cancelled` visibile, history undo/redo lifecycle (undoStack/redoStack), rollback reporting truthful, direct execution result (no envelope), schema strict, rimozione varianti (superficie fissa a 5)
- [x] README.md (Atelier primary / Redini secondary, flusso, "How this differs" onesto, atomicity claim scoped, come far girare, ?clean=1 / ?debug=1)
- [x] Pulizia codice: safe DOM (no innerHTML dinamico), CSS senza blocchi morti, docs v3, `npm run build` senza errori
- [x] Pass history/UI (commit 45ee190): undo/redo editor-style completo nel pannello (bottoni + tastiera ⌘Z / ⇧⌘Z / Ctrl+Y, mai sugli input di testo), redo invalidato da ogni nuovo commit
- [x] Micro-hardening finale (post-45ee190): commit fallito → sweep dei pending (isStale immediato anche senza getStateVersion), `getHistory()` come DTO isolato (structuredClone), actor provenance (proposte umane mai "Agent proposed"), template come `<button>` semantici, Commit disabilitato a 0 operazioni, docs undo/redo sincronizzate
- [ ] Repo pubblico: licenza visibile nell'About, description curata

**Fatto quando**: un estraneo clona il repo, segue il README e fa girare tutto.

### Giorno 5 — 02/09: video + submission (MARGINE: resta il 3/09 solo per emergenze)
- [ ] Script del video (< 3 min, UNO scenario continuo — golden path): richiesta ("rendi il poster più minimal") → l'agente propone UN ChangeSet a 3 operazioni via WebMCP → l'umano ne modifica una (amend tipizzato), ne esclude una (cherry-pick), committa il subset → receipt a 4 sezioni (INTENDED / AMENDED BY HUMAN / SKIPPED BY HUMAN / APPLIED) → l'agente riceve la risposta strutturata e continua → undo deterministico su un click (20s) → claim libreria riusabile (20s)
- [ ] Registrazione con audio chiaro (schermo + voce), niente musica coperta da copyright
- [ ] Upload YouTube pubblico
- [ ] Testo submission in inglese (4 punti richiesti dalle regole)
- [ ] Submit su Devpost

**Fatto quando**: submission inviata con 24h di margine.

## 2. Definizione di Done (submission pronta)

- [ ] Live URL funzionante in browser con WebMCP (test finale il giorno della submission)
- [ ] Repo pubblico, MIT, README completo, fresh-clone funziona
- [ ] Video YouTube pubblico < 3 min con audio
- [ ] Testo submission in inglese sui 4 punti delle regole
- [ ] Sito accessibile gratis e senza restrizioni fino al 21 settembre
- [ ] Submit effettuato entro le 22:00 del 3 settembre (target: 2 settembre)

## 3. Regole d'ingaggio (da rispettare senza eccezioni)

1. Niente feature nuove dopo il 31 agosto. Dal 1 settembre si lucida e basta.
2. Ogni sera: commit + push su main; il deploy Netlify è sempre lo stato dell'arte.
3. Se un test dello spike fallisce, si applica il fallback previsto — non si riscrive la strategia il giorno 3.
4. Il video si registra il 2 settembre, non il 3.
