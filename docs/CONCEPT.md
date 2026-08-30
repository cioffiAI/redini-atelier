# CONCEPT — "Redini" (nome di lavoro)
> Atelier turns an agent action into an editable ChangeSet. People can preview, amend, cherry-pick, commit and undo changes before the live canvas is mutated.
> Redini is the transaction layer underneath.

Stato: BOZZA v0.3 — 30/08/2026 — cambio di centro di gravità: da "consent wrapper" (già territorio affollato: @mcptrail/webmcp-consent, WebMCP Text Editor, WebMCP+Legit) alla **negoziazione umano-agente di un ChangeSet multi-operazione**.

Nuova unità centrale:

```text
Agent intent
      ↓
ONE WebMCP call (design_update)
      ↓
ChangeSet — es. 5 operazioni

[✓] setText title → "AI SUMMIT"
[✓] setFill background → #FF0055
[✓] setFont → serif
[ ] move logo → (620, 40)      ← l'umano la esclude
[✓] resize logo → 120
      ↓
l'umano può: modificare i parametri (amend), escludere operazioni (cherry-pick), vedere il ghost
      ↓
atomic commit del subset
      ↓
RECEIPT: INTENDED / AMENDED / SKIPPED BY HUMAN / APPLIED / STATE v→v / UNDO
      ↓
undo deterministico (inverse operations, non snapshot)
```

## 2. Perché questo claim (e non quello vecchio)

### 2.1 La falsificazione che ha costretto il pivot
Il claim originale — "un wrapper di conferma per WebMCP" — è stato verificato e **risulta già occupato**:
- `@mcptrail/webmcp-consent` (npm, v0.1.0): wrapping della registrazione WebMCP con policy `auto/confirm/deny` e modal di approvazione. **Confermato esistente** (verificato il 29/08/2026).
- Pattern `readOnlyHint` per letture automatiche + `confirm()` per le scritture: già usato da agent GUI esistenti.
- Il flag `annotations.readOnlyHint` esiste già nella stessa spec WebMCP: la distinzione safe/mutante da sola è tabella, non innovazione.

### 2.2 Il claim nuovo e la sua difendibilità
L'approvazione è solo un pezzo. L'unità di Redini è la **transazione agentica**:

```
agent intent → proposed mutation → visual preview/diff → human edit → commit → receipt → undo
```

La combinazione — **live visual collaboration + staged transactions + editable proposal + rollback + audit trail** — è ciò che i confirmation gate esistenti NON hanno:
- **Editable proposal**: l'umano modifica i parametri della proposta prima del commit (il gate esistente dice solo sì/no).
- **Visual preview/diff**: il cambiamento proposto si vede sul prodotto reale prima di accaderlo (nel nostro caso: la locandina prima/dopo), non è un modal astratto.
- **Receipts**: ogni commit produce una ricevuta strutturata (id, cambiamenti, timestamp, stato v→v) — tracciabilità a livello di transazione, non di log.
- **Rollback nativo**: l'undo deterministico (via inverse operations, niente snapshot) è parte della transazione, non un'afterthought.
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
| Tutto ciò che si commetta ha una ricevuta | Receipt strutturata: id, cambiamenti, timestamp, stato v→v |
| Tutto ciò che si commetta è reversibile | Rollback con un click; la ricevuta lo riferisce nell'audit trail |
| L'agente non perde il filo | Ogni proposta riceve risposta strutturata (committed / modified / declined) — la collaborazione continua |

## 5. Cosa consegna il progetto

1. **`redini/`** — libreria open source (~600 righe, zero dipendenze, application-agnostic):
   - `registerChangeSetTool()` (con `registerSafeTool()` per i read-only)
   - ChangeSet multi-operazione: staging, per-op amend validato, cherry-pick, commit atomico del subset
   - Receipt a righe strutturate: `intended / amended / skippedByHuman / applied` (con i valori realmente committati)
   - Undo/redo deterministici via **inverse operations** (niente snapshot store): history editor-style con `undoStack`/`redoStack` — `undo()`/`redo()` senza token, ogni nuovo commit invalida il redo
   - Audit trail di provenienza (chi ha proposto cosa, cosa l'umano ha cambiato, esito)
2. **Atelier** — studio di design agent-native dove il flusso è:
   un intent → 3 operazioni proposte → l'umano ne commetta una, ne modifica una (amend via form tipizzati), ne esclude una → ghost preview sul canvas prima del commit → receipt 4 sezioni → undo deterministico
3. **Un caso avversario**: un contenuto di vendor non affidabile induce l'agente a proporre una mutazione non richiesta → Redini mostra che resta una proposta in staging, l'umano la rifiuta con un click.

## 6. Atelier: perché è il dimostratore giusto

Un todo-list o un CRM renderebbero Redini una demo CRUD tra mille. In un **editor visuale**:
- Le mutazioni sono visibili (diff reale sul ghost preview, non descrizione astratta).
- La collaborazione umano-agente è naturale ("rendilo più minimal" → proposta → correzione "blu → verde" via amend per-operazione).
- La storia si chiude in un arco unico: un intent → un ChangeSet multi-op → negoziazione → commit del subset → receipt → undo.
- È il caso d'uso flagship della stessa spec WebMCP (Jen e il flyer): i giudici lo riconoscono.

## 7. Mappatura ai 4 criteri di giudizio (stima post-pivot)

| Criterio | Come Redini lo soddisfa | Stima |
|---|---|---|
| WebMCP Leverage | Superficie API usata in v3: registerTool + inputSchema strict per-kind (hand-authored, registrato verbatim), readOnlyHint/untrustedContentHint, AbortSignal, blocking execute verificato >90s. Niente dynamic tools/toolchange/declarative form/respondWith in v3 — rimossi, la superficie è fissa a 5 tool | 7.5/10 |
| Execution | Atelier come prodotto rifinito (non playground): flusso completo con ChangeSet negoziato | 8/10 (se il polish è curato) |
| Potential Impact | Le mutazioni agentiche sono il collo di bottiglia dell'adozione; libreria riusabile da qualsiasi app WebMCP | 7.5/10 |
| Creativity & Ambition | Da 5.5-6/10 col claim della sola conferma (già occupato) a 8-8.5/10 col claim "transactional human control": inspect/edit/commit/rollback vs popup "Allow?" | 8-8.5/10 |

## 8. Cosa impari (obiettivo personale)

Costruire una transaction layer obbliga a dominare: lifecycle dei tool, blocking execute e timeout, API dichiarativa dei form (che È già una transazione in staging nativa — la spec lo conferma con `:tool-form-active`), AbortSignal, schema synthesis, e design di API con semantica transazionale. Più la disciplina di verificare le assunzioni su terra reale (lo spike ha già corretto due assunzioni: firma JSON-string di executeTool, attesa illimitata delle promesse).

## 9. Criteri di successo

1. Funziona nel browser in-app di ChatGPT E in Chrome 149+ (flag), senza errori in console.
2. Nel video, UN solo scenario continuo < 3 min: richiesta iniziale ("rendi il poster più minimal" in un intent) → ChangeSet a 3 operazioni in staging → amend di una, skip di un'altra, commit del subset → receipt 4 sezioni → l'agente riceve la risposta strutturata e continua → undo deterministico → caso avversario (vendor injection, rifiuto).
3. La libreria è copiabile in un altro progetto; il README spiega il pattern in 30 secondi.
4. Repo pubblico, MIT, distintivo in About.
5. Tutto consegnato entro le 22:00 italiane del 3 settembre — target: pronto il 2 settembre.
