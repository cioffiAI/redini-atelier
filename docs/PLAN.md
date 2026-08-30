# PIANO OPERATIVO — 5 giorni alla deadline
Deadline submission: **3 settembre 2026, 22:00 ora italiana** (13:00 PDT)
Judging: 4-21 settembre · Vincitori: ~23 settembre

---

## 1. Piano giorno per giorno (variante SOLO)

Ipotesi: ~8-10 ore/giorno di lavoro effettivo. Ogni giorno ha un criterio di "fatto" verificabile.

### Giorno 1 — 29/08: fondamenta + spike (IL giorno più importante)
- [x] Scaffold Vite + TS con build verde, repo GitHub `cioffiAI/redini-atelier` (privato, pubblica il giorno 4) con LICENZA MIT, struttura src/ (redini/ + atelier/), tool spike `list_templates` già registrato nel codice
- [x] Documenti di progetto: CONCEPT, TECHNICAL-DESIGN, PLAN, SPIKE
- [ ] **Azione utente**: installare ChatGPT Desktop + Chrome 149+, attivare flag, deploy su Netlify (docs/SPIKE.md §0)
- [ ] **SPIKE: eseguire i 6 test** di docs/SPIKE.md in entrambi i browser e compilare la tabella risultati
- [ ] Decisione Go/No-Go su API dichiarativa e approvazione bloccante in base agli esiti

**Fatto quando**: un tool gira davvero nel browser di ChatGPT sul sito deployato su Netlify, tabella spike compilata.

### Giorno 2 — 30/08: il cuore (libreria redini, semantica transazionale) — COMPLETATO
- [x] `registerTransactionalTool()` / `registerSafeTool()` / `register()` con mode safe/transaction (args = stringa JSON: firma Chrome verificata)
- [x] Transazioni first-class: `Transaction {id, proposedInput, committedInput, stateVersion, status, proposedAt, committedAt}` con lifecycle `proposed → reviewing → committed | declined → undone (+ stale | failed)`
- [x] Staging area DOM (card con preview, parametri editabili via JSON, Commit/Modifica/Rifiuta) + adapter InMemory per test
- [x] Receipts (txId, undoToken, stateBefore/stateAfter) + SnapshotStore + rollback single-use
- [x] Stale guard: contatore mutazioni interno + `getStateVersion` opzionale → `STALE_TRANSACTION`
- [x] Provenance / audit trail (kind, txId, humanEdited)
- [x] 14/14 test gate passati (`npm test`, vitest) — inclusi: decline senza execute, fallimento senza false receipt, undo esatto, double-undo deterministico, due transazioni concorrenti, AbortSignal in attesa, promessa WebMCP chiusa solo dopo decisione, `proposedInput !== committedInput`
- [x] E2E playground nel browser reale (`scripts/playground-e2e.mjs`): proposta → commit → receipt → undo → decline → audit, tutto OK
- [x] API che emette sempre outcome strutturato all'agente (committed/declined_by_user/cancelled/stale_transaction/execute_failed)

**Fatto**: le quattro vie (commit / modifica+commit / rifiuto / rollback) producono receipt coerenti nell'audit trail — verificato in unit test E nel browser.

### Giorno 3 — 31/08: Atelier (l'app) — COMPLETATO
- [x] Canvas flyer completo (titolo, sottotitolo, data, colori, font, clipart) + 4 template mock con note vendor
- [x] 8 tool registrati via Redini: 4 safe (list_templates, get_current_design, filter_templates, get_vendor_content) + 4 transazionali (edit_flyer, apply_template, create_variant, order_prints)
- [x] Checkout dichiarativo spec-native (order_prints_form, senza toolautosubmit → submit sempre umano, respondWith all'agente)
- [x] Ghost preview: le proposte in staging si vedono sul canvas PRIMA di accadere (differenziatore visivo)
- [x] Varianti dinamiche: create_variant registra select_variant_N; undo → abort controller → deregistrazione (coerente anche senza model context)
- [x] Caso avversario: get_vendor_content (untrustedContentHint) con iniezione nel template evening-gala
- [x] Azioni umane dirette (click template) passano anch'esse da transazioni (dispatch+commit immediato) → audit completo
- [x] 22/22 test (14 core + 8 atelier) + e2e browser completo (scripts/atelier-e2e.mjs): staging→ghost→commit→undo→order→decline→audit ALL OK

**Fatto quando**: flusso completo dimostrabile: template → modifiche approvate → varianti → checkout rivisto dall'utente.

### Giorno 4 — 01/09: solidità + repo
- [ ] Edge case: rifiuti multipli, undo multipli, tool deregistrati, reload pagina
- [ ] README.md (pitch 30 secondi + quickstart + spiegazione pattern + problemi aperti della spec risolti)
- [ ] Pulizia codice, `npm run build` senza errori, test fresh-clone
- [ ] Repo pubblico: licenza visibile nell'About, description curata

**Fatto quando**: un estraneo clona il repo, segue il README e fa girare tutto.

### Giorno 5 — 02/09: video + submission (MARGINE: resta il 3/09 solo per emergenze)
- [ ] Script del video (< 3 min, UNO scenario continuo): richiesta ("prepara una locandina per...") → l'agente trova il template via WebMCP → 3 proposte in staging: 1 commessa, 1 modificata poi commessa, 1 rifiutata → l'agente continua senza perdere contesto → undo → caso avversario (iniezione vendor, rifiuto) → "ordina 50 copie" → barriera massima + ricevuta finale (150s) → claim libreria riusabile (20s)
- [ ] Registrazione con audio chiaro (schermo + voce), niente musica coperta da copyright
- [ ] Upload YouTube pubblico
- [ ] Testo submission in inglese (4 punti richiesti dalle regole)
- [ ] Submit su Devpost

**Fatto quando**: submission inviata con 24h di margine.

## 2. Analisi team: solo vs +1 vs team più grande

### Solo (situazione attuale)
**Pro**
- Zero overhead di coordinamento: ogni ora va nel prodotto.
- Visione unica e coerente (importante per il criterio Execution: prodotto coerente).
- Massima proprietà dell'apprendimento (obiettivo personale dichiarato).
- IP più semplice: le regole chiedono che la submission sia il lavoro originale dell'entrant; da solo è automatico.

**Contro**
- Single point of failure: stanchezza, imprevisti, un bug bloccante il giorno 4.
- Impossibile parallelizzare codice / video / testo.
- Il testing "a quattro occhi" sui flussi UX manca (rischio di dare per scontate cose che un giudice nota subito).

**Verdetto**: fattibile SE lo scope resta quello definito in TECHNICAL-DESIGN (editor minimale). Il piano sopra ha margine: il giorno 5 è dedicato solo a video/testo e il 3 settembre resta cuscinetto.

### Con tuo fratello (o un'altra persona)
**Pro**
- Parallelismo reale con la divisione giusta:
  - Persona A: libreria redini + tool + integrazione agente (il cuore tecnico)
  - Persona B: UI Atelier + pannello guardrail + polish + video + testo submission
- QA reciproco: ogni flusso provato da chi non l'ha scritto = meno sorprese nel judging.
- Resilienza: un giorno perso da uno non affonda il progetto.

**Contro**
- Overhead di coordinamento: se non tecnico/esperto, il tempo per spiegargli WebMCP può superare il tempo guadagnato. Serve almeno un giorno suo di ramp-up.
- Regole: va nominato un Representative (uno dei due); premi con limiti "up to 3 team members" (Pro account e swag coprono entrambi, nessun problema).
- Rischio conflitti di merge e decisioni di design prese in due sotto pressione.

**Verdetto**: CONSIGLIATO se tuo fratello (a) è tecnico (JS/TS almeno base), (b) può garantire ~20 ore in 5 giorni, (c) accettate la divisione A/B qui sopra dal giorno 1. Se anche una sola condizione manca: resta solo.

**Domande per decidere** (da fargli):
1. Hai mai scritto TypeScript/JavaScript moderno? Quanto ti senti da 1 a 10?
2. Quante ore realistiche hai tra il 29 agosto e il 2 settembre?
3. Ti va di occuparti di UI + video + documentazione, lasciando il core WebMCP a me? (divisione che massimizza il tuo apprendimento del protocollo)

### Team più grande (>2)
Sconsigliato per questo progetto: lo scope è dimensionato per 1-2 persone; in 3+ si pestano i piedi e il coordinamento mangia il margine. Le regole non lo vietano, ma il rapporto costi/benefici è negativo con 5 giorni.

## 3. Definition of Done (submission pronta)

- [ ] Live URL funzionante in ChatGPT in-app browser (test finale il giorno della submission)
- [ ] Repo pubblico, MIT, README completo, fresh-clone funziona
- [ ] Video YouTube pubblico < 3 min con audio
- [ ] Testo submission in inglese sui 4 punti delle regole
- [ ] Sito accessibile gratis e senza restrizioni fino al 21 settembre
- [ ] Submit effettuato entro le 22:00 del 3 settembre (target: 2 settembre)

## 4. Regole d'ingaggio (da rispettare senza eccezioni)

1. Niente feature nuove dopo il 31 agosto. Dal 1 settembre si lucida e basta.
2. Ogni sera: commit + push su main; il deploy Netlify è sempre lo stato dell'arte.
3. Se un test dello spike fallisce, si applica il fallback previsto — non si riscrive la strategia il giorno 3.
4. Il video si registra il 2 settembre, non il 3.
