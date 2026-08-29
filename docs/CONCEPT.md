# CONCEPT — "Redini" (nome di lavoro)
> Un layer di fiducia Human-in-the-Loop per il web agent-native, dimostrato con uno studio di design.

Stato: BOZZA v0.1 — 29/08/2026
Regole di riferimento: Official Rules "The WebMCP Challenge" (webmcp.devpost.com) — deadline 3 set 2026, 22:00 ora italiana.

---

## 1. Tesi in una frase

Gli agenti sul web oggi sono potenti ma **non affidabili**: il collo di bottiglia dell'adozione non è la capacità dell'agente, è la **fiducia dell'utente**. "Redini" è il livello che mancava tra l'agente e l'utente: approvazione prima delle azioni mutanti, reversibilità totale, visibilità completa — come libreria aperta riusabile da qualsiasi sito WebMCP, dimostrata dentro un'app prodotto completa.

## 2. Il problema (perché esiste questo progetto)

### 2.1 Il punto cieco della spec
La spec WebMCP ha un capitolo "Open Questions" esplicito. Due issue sono dedicate esattamente a questo:

- **Issue #165 / #50 — "User prompting and elicitation"**: come può un tool chiedere conferma all'utente quando serve autorizzazione esplicita? La spec elenca due strade (delegare all'agente/harness, oppure un dialogo nativo del browser fuori dal loop dell'agente) ma **non ne implementa nessuna**. È terreno aperto.
- La API dichiarativa ha già un embrione di risposta (form senza `toolautosubmit` → l'utente rivede e invia), ma solo per i form. Per i tool imperativi mutanti non esiste nulla.

Nessun progetto nell'ecosistema (starter, showcase, demo indicizzati su GitHub) affronta sistematicamente il tema: i demo eseguono le azioni dell'agente e basta.

### 2.2 Il problema per l'utente finale (Human-in-the-loop)
Chi userà app WebMCP nella vita reale avrà tre paure:
1. "L'agente ha fatto qualcosa che non volevo" (azioni irreversibili).
2. "Non so cosa stia facendo adesso" (opacità).
3. "Non posso correggerlo" (assenza di override).

Redini risponde con tre garanzie, una per paura:
1. **Approvazione**: le azioni mutanti non si eseguono da sole; entrano in una coda con anteprima.
2. **Trasparenza**: ogni chiamata di tool è tracciata in un log visibile.
3. **Reversibilità**: ogni azione approvata è annullabile (snapshot + undo).

## 3. Principi di design

| Principio | Regola concreta |
|---|---|
| Leggere è gratis, agire si approva | Tool read-only (`isSafe: true`) girano senza conferma; tool mutanti passano dalla coda di approvazione |
| L'utente è il boss, l'agente propone | L'utente può approvare, modificare i parametri prima dell'ok, rifiutare |
| Tutto è reversibile | Ogni azione mutante fa uno snapshot prima di eseguire; undo stack illimitato nella sessione |
| Il form è un checkpoint naturale | I form dichiarativi senza `toolautosubmit` sono il punto di revisione per eccellenza; la UI li evidenzia quando l'agente li riempie |
| L'agente resta utile | Il guardrail non blocca l'agente: gli risponde sempre (accettato/rifiutato/modificato) così la conversazione continua |

## 4. Cosa consegna il progetto

1. **`redini/`** — libreria aperta (~400-600 righe, zero dipendenze) che avvolge `document.modelContext`:
   - `registerGuardedTool()` con policy `safe` / `approval-required`
   - Coda di approvazione con anteprima e modifica parametri
   - Snapshot/undo automatico per azioni mutanti
   - Log attività leggibile
2. **App demo: "Atelier"** — studio di design di un flyer/locandina:
   - L'agente cerca template, propone modifiche (titolo, colori, font, layout), crea varianti — ogni modifica passa dall'approvazione con anteprima
   - Checkout stampa con form dichiarativo rivisto dall'utente
   - Undo: "annulla le ultime modifiche dell'agente"
3. **Documentazione**: README del pattern, esempi riuso, nota su come il pattern risolve gli issue aperti #165/#50 (con link alla spec).

## 5. Posizionamento rispetto alle altre submission

Con 3.635 partecipanti, la maggior parte farà l'app verticale (shop, travel, CRM). Tre categorie attese:
- "Ho aggiunto tool WebMCP a una todo-app" — banale, eliminabile.
- "App verticale ben fatta" — buona esecuzione, poca novità.
- "Ho capito qualcosa del protocollo che altri non hanno capito" — rara.

Redini sta nella terza categoria con un prodotto della seconda: **novità a livello protocollo + esecuzione prodotto completa**. È la combinazione che i criteri premiano esplicitamente (Creativity & Ambition + Execution insieme).

Giudici particolarmente sensibili a questo taglio:
- **Alex Nahas** (creatore di MCP-B): il progetto dialoga con l'evoluzione del protocollo.
- **Justin Rushing** (Browser Platform Lead, OpenAI): il punto di conferma utente è esattamente il problema di chi costruisce il browser agent.
- **Sarah Drasner** (Chrome): la spec è guidata da Google; affrontare una sua open question è il miglior complimento possibile.

## 6. Risposta ai 4 criteri di giudizio

| Criterio | Come Redini lo soddisfa | Rischio residuo |
|---|---|---|
| WebMCP Leverage | Usa l'intera superficie API: registerTool + signal, tool dinamici, toolchange, isSafe, form dichiarativi (toolname/toolparamdescription/respondWith), AbortSignal, getTools/executeTool | Se la declarative API non è supportata nei browser di test, va coperta con fallback (vedi TECH-DESIGN §7) |
| Execution | Atelier è un prodotto completo e usabile, non un PoC: design reale, checkout, undo, stato persistente in sessione | Il rischio n.1 è scope creep: l'editor di design DEVE restare semplice |
| Potential Impact | Il problema della fiducia è reale e crescente; la libreria è riusabile da ogni sito WebMCP; il pattern risponde a issue aperti della spec | Va raccontato bene nel testo/video, non è autoevidente |
| Creativity & Ambition | Nessun concorrente atteso fa un trust layer; affronta una open question della spec | I giudici potrebbero preferire l'impatto verticale puro: il checkout/stampa dà proprio quella dimensione |

## 7. Cosa impari (obiettivo personale dichiarato)

Costruire Redini ti obbliga a toccare praticamente ogni angolo della API: registrazione e deregistrazione dinamica, validazione inputSchema, eventi toolchange, API dichiarativa dei form, segnali di abort, pattern read-only/mutanti. È il percorso di apprendimento più completo possibile in un singolo progetto.

## 8. Criteri di successo della submission

1. Funziona nel browser in-app di ChatGPT E in Chrome 149+ con flag, senza errori in console.
2. Nel video: l'agente propone → l'utente approva/modifica/rifiuta → undo funziona. Tre momenti chiari.
3. La libreria è importabile in un altro progetto con un copia-incolla.
4. Repo pubblico, licenza MIT visibile, README che spiega il pattern in 30 secondi.
5. Tutto consegnato entro le 22:00 italiane del 3 settembre, con margine (obiettivo: pronto il 2 settembre).
