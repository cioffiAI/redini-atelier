# PIANO OPERATIVO — 5 giorni alla deadline
Deadline submission: **3 settembre 2026, 22:00 ora italiana** (13:00 PDT)
Judging: 4-21 settembre · Vincitori: ~23 settembre

---

## 1. Piano giorno per giorno (variante SOLO)

Ipotesi: ~8-10 ore/giorno di lavoro effettivo. Ogni giorno ha un criterio di "fatto" verificabile.

### Giorno 1 — 29/08: fondamenta + spike (IL giorno più importante)
- [ ] Scaffold Vite + TS, repo GitHub privato→pubblico con LICENZA MIT, deploy automatico Netlify collegato (funziona anche senza crediti)
- [ ] **SPIKE: matrice di verifica browser** (TECH-DESIGN §6, test 1-7) in ChatGPT in-app browser e Chrome+flag
- [ ] Primo tool end-to-end: `list_templates` chiamato dall'agente con risposta reale
- [ ] Decisione Go/No-Go su API dichiarativa in base agli esiti

**Fatto quando**: un tool gira davvero nel browser di ChatGPT sul sito deployato su Netlify.

### Giorno 2 — 30/08: il cuore (libreria redini)
- [ ] `registerGuardedTool()` con mode safe/approval-required
- [ ] Coda approvazione (UI panel: card con Approva/Modifica/Rifiuta)
- [ ] SnapshotStore + undo funzionante
- [ ] Log attività
- [ ] Test manuale: agente chiama un tool mutante → coda → approvazione → esecuzione

**Fatto quando**: l'agente propone un'azione, l'utente la approva, l'undo la annulla.

### Giorno 3 — 31/08: Atelier (l'app)
- [ ] Canvas flyer con i 6 campi + 4 template mock
- [ ] Tutti i 6 tool imperativi registrati (con tool dinamici per le varianti)
- [ ] Form dichiarativo checkout (o fallback F1 se lo spike ha bocciato la declarative)
- [ ] UI guardrail integrata e presentabile

**Fatto quando**: flusso completo dimostrabile: template → modifiche approvate → varianti → checkout rivisto dall'utente.

### Giorno 4 — 01/09: solidità + repo
- [ ] Edge case: rifiuti multipli, undo multipli, tool deregistrati, reload pagina
- [ ] README.md (pitch 30 secondi + quickstart + spiegazione pattern + problemi aperti della spec risolti)
- [ ] Pulizia codice, `npm run build` senza errori, test fresh-clone
- [ ] Repo pubblico: licenza visibile nell'About, description curata

**Fatto quando**: un estraneo clona il repo, segue il README e fa girare tutto.

### Giorno 5 — 02/09: video + submission (MARGINE: resta il 3/09 solo per emergenze)
- [ ] Script del video (< 3 min): problema (20s) → demo flusso agente+approvazione (90s) → undo e form (40s) → perché conta / libreria riusabile (30s)
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
