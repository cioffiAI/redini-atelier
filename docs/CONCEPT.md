# CONCEPT — "Redini" (nome di lavoro)
> Transaction layer for agentic web actions — dimostrato da Atelier, studio di design agent-native.

Stato: BOZZA v0.2 — 29/08/2026 (pivot di posizionamento dal "consent wrapper" alla transaction layer)
Regole di riferimento: Official Rules "The WebMCP Challenge" (webmcp.devpost.com) — deadline 3 set 2026, 13:00 PDT (22:00 ora italiana). Prem premi: $35.000 cash totali, 10 vincitori × $3.500 cash ($3.000 OpenAI + $500 Netlify) + crediti/gear.

---

## 1. Tesi in una frase

**Agents shouldn't directly mutate your web app. They should propose transactions humans can inspect, modify, commit, and reverse.**

Redini è una transaction layer per le azioni agentiche sul web: ogni mutazione richiesta da un agente diventa una transazione in staging — con anteprima del diff, parametri modificabili dall'umano, commit che produce una ricevuta, e rollback. L'agente mantiene l'iniziativa; l'utente mantiene il controllo dello stato.

## 2. Perché questo claim (e non quello vecchio)

### 2.1 La falsificazione che ha costretto il pivot
Il claim originale — "human approval per WebMCP" — è stato verificato e **risulta già occupato**:
- `@mcptrail/webmcp-consent` (npm, v0.1.0): wrapping della registrazione WebMCP con policy `auto/confirm/deny` e modal di approvazione. **Confermato esistente** (verificato il 29/08/2026).
- Pattern `readOnlyHint` per letture automatiche + `confirm()` per le scritture: già usato da agent GUI esistenti.
- Il flag `annotations.readOnlyHint` esiste già nella stessa spec WebMCP: la distinzione safe/mutante da sola è tabella, non innovazione.

### 2.2 Il claim nuovo e la sua difendibilità
L'approvazione è solo un pezzo. L'unità di Redini è la **transazione agentica**:

```
agent intent → proposed mutation → visual preview/diff → human edit → commit → receipt → undo
```

La combinazione — **live visual collaboration + staged transactions + editable approval + rollback + audit trail** — è ciò che i confirmation gate esistenti NON hanno:
- **Editable approval**: l'umano modifica i parametri della proposta prima del commit (il gate esistente dice solo sì/no).
- **Visual preview/diff**: il cambiamento proposto si vede sul prodotto reale prima di accaderlo (nel nostro caso: la locandina prima/dopo), non è un modal astratto.
- **Receipts**: ogni commit produce una ricevuta strutturata (id, cambiamenti, timestamp, undo token) — tracciabilità a livello di transazione, non di log.
- **Rollback nativo**: lo snapshot/undo è parte della transazione, non un'afterthought.
- **Provenance**: audit trail completo di chi ha proposto cosa, cosa l'umano ha cambiato nella proposta, esito.

## 3. Posizionamento onesto (NO security theater)

Redini **gira nella pagina**: un'app malevola o compromessa può aggirare un controllo client-side. Quindi:
- ❌ NON presentiamo Redini come "rende sicuro WebMCP" o "security boundary".
- ✅ Presentiamo Redini come **human control, recoverability, auditable mutations**: l'utente vede, decide, corregge e torna indietro. Autorizzazione e validazione vere restano server-side (dove devono stare).
- Valore aggiunto: Redini riduce anche il blast radius di **content injection** (un contenuto non affidabile che induce l'agente a mutazioni non richieste): la mutazione resta una proposta ispezionabile, non diventa automaticamente stato dell'app. Un caso avversario in demo lo dimostra.

## 4. Principi di design

| Principio | Regola concreta |
|---|---|
| Leggere è gratis, mutare è una transazione | Tool read-only (`readOnlyHint`) girano subito; le mutazioni entrano in staging |
| L'umano modifica la proposta, non solo la approva | Ogni transazione in staging è editabile nei parametri prima del commit |
| Vedi prima che accada | Preview del diff sul prodotto reale (prima/dopo) dentro la card di staging |
| Tutto ciò che si commetta ha una ricevuta | Receipt strutturata: id, cambiamenti, timestamp, undo token |
| Tutto ciò che si commetta è reversibile | Rollback con un click; la ricevuta lo riferisce nell'audit trail |
| L'agente non perde il filo | Ogni proposta riceve risposta strutturata (committed / modified / declined) — la collaborazione continua |

## 5. Cosa consegna il progetto

1. **`redini/`** — libreria open source (~500-700 righe, zero dipendenze):
   - `registerGuardedTool()` con `mode: 'safe' | 'transaction'`
   - Staging area: transazioni proposte con preview/diff e parametri editabili
   - Commit → Receipt `{ txId, tool, input, result, timestamp, undoToken }`
   - Rollback via snapshot store; activity log = provenance
2. **Atelier** — studio di design agent-native dove il workflow è:
   template → l'agente propone 3 mutazioni → l'umano ne commetta una, ne modifica una, ne rifiuta una → l'agente continua senza perdere contesto → undo → **order_prints** (barriera massima: revisione esplicita del design esatto che verrà stampato, ricevuta finale)
3. **Un caso avversario**: un contenuto di vendor non affidabile induce l'agente a proporre una mutazione non richiesta → Redini mostra che resta una proposta in staging, l'umano la rifiuta con un click.

## 6. Atelier: perché è il dimostratore giusto

Un todo-list o un CRM renderebbero Redini una demo CRUD tra mille. In un **editor visuale**:
- Le mutazioni sono visibili (diff reale, non descrizione astratta).
- La collaborazione umano-agente è naturale ("rendilo più minimal" → proposta → correzione "blu → verde").
- L'ultima azione — **ordinare la stampa** — è un'azione reale, costosa, diversa dalle precedenti: giustifica la barriera di commit più forte e chiude la storia.
- È il caso d'uso flagship della stessa spec WebMCP (Jen e il flyer): i giudici lo riconoscono.

## 7. Mappatura ai 4 criteri di giudizio (stima post-pivot)

| Criterio | Come Redini lo soddisfa | Stima |
|---|---|---|
| WebMCP Leverage | Tutta la superficie API: registerTool, dynamic tools, toolchange, readOnlyHint, declarative form (schema synthesis verificata in Chrome!), respondWith, AbortSignal, blocking execute verificato >90s | 8.5/10 |
| Execution | Atelier come prodotto rifinito (non playground): flusso completo con checkout reale | 8/10 (se il polish è curato) |
| Potential Impact | Le mutazioni agentiche sono il collo di bottiglia dell'adozione; libreria riusabile da qualsiasi app WebMCP | 7.5/10 |
| Creativity & Ambition | Da 5.5-6/10 col claim "approval" (già occupato) a 8-8.5/10 col claim "transactional human control": inspect/edit/commit/rollback vs popup "Allow?" | 8-8.5/10 |

## 8. Cosa impari (obiettivo personale)

Costruire una transaction layer obbliga a dominare: lifecycle dei tool, blocking execute e timeout, API dichiarativa dei form (che È già una transazione in staging nativa — la spec lo conferma con `:tool-form-active`), AbortSignal, schema synthesis, e design di API con semantica transazionale. Più la disciplina di verificare le assunzioni su terra reale (lo spike ha già corretto due assunzioni: firma JSON-string di executeTool, attesa illimitata delle promesse).

## 9. Criteri di successo

1. Funziona nel browser in-app di ChatGPT E in Chrome 149+ (flag), senza errori in console.
2. Nel video, UN solo scenario continuo < 3 min: richiesta iniziale → 3 proposte in staging (commit / edit+commit / decline) → l'agente continua → undo → caso avversario → checkout stampa con ricevuta.
3. La libreria è copiabile in un altro progetto; il README spiega il pattern in 30 secondi.
4. Repo pubblico, MIT, distintivo in About.
5. Tutto consegnato entro le 22:00 italiane del 3 settembre — target: pronto il 2 settembre.
