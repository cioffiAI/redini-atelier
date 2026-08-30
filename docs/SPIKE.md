# SPIKE — Verifica pre-costruzione (Giorno 1)
Obiettivo: verificare su TERRA REALE che la pipeline WebMCP si comporti come previsto, PRIMA di scrivere il prodotto. Ogni test ha un esito binario e un fallback già progettato (TECHNICAL-DESIGN §6).

---

## 0. Prerequisiti (AZIONE UTENTE, ~20 minuti)

| # | Azione | Verifica |
|---|---|---|
| 0.1 | Installare **ChatGPT Desktop** da https://chatgpt.com/download | L'app si apre e fa il login |
| 0.2 | Installare **Google Chrome**. Serve versione **149+**: scaricabile da google.com/chrome. Se la stable fosse <149, usare Chrome Beta/Canary | Aprire chrome://version e segnare la versione |
| 0.3 | In Chrome: aprire `chrome://flags/#enable-webmcp-testing` → **Enabled** → Riavvia | Il flag è presente ed enabled |
| 0.4 | Deploy della scaffold su **Netlify**: npm run build → trascinare la cartella `dist/` su https://app.netlify.com/drop (oppure collegare il repo GitHub da app.netlify.com) | URL pubblico https://…netlify.app risponde |

> **Stato 29/08 pomeriggio**: 0.1 e 0.2 FATTE (ChatGPT installato+login; utente conferma Chrome con flag MCP testing abilitato). 0.4 ancora da fare.
> I 6 test NON richiedono codice temporaneo: tutti i tool di test (slow_tool, test_booking form, add_note, temp_echo) sono già nell'app (commit `spike tools`).
> L'ambiente localhost è già in funzione: `npm run dev` gira su http://localhost:5173 (avviato in background, log in /tmp/vite-dev.log).

## 1. Come eseguire i test

In ogni browser di test (ChatGPT in-app browser e Chrome+flag):
1. Aprire l'URL del sito (Netlify o localhost)
2. Verificare che il badge in alto dica "WebMCP available" (verde)
3. Nel pannello conversazione dell'agente, scrivere il prompt indicato dal test
4. Registrare l'esito nella tabella §3

## 2. I test, in ordine di priorità

### Test 1 — Pipeline base (BLOCCANTE)
**Prompt all'agente**: `List the available flyer templates` (e poi: `list only spring themed templates`)
**Atteso**: l'agente vede il tool `list_templates`, lo chiama, riceve il JSON dei template e risponde in linguaggio naturale elencandoli; con il filtro spring, risponde solo con Spring Market.
**Se fallisce in entrambi i browser**: STOP — rivalutare la strategia (giorno 1, non giorno 4).

### Test 2 — Timeout del tool in attesa umana (IL test più importante per Redini)
Setup: aggiungere temporaneamente in main.ts un tool `slow_tool` la cui execute attende una promessa risolta manualmente (es. esposta su window: `window.resolveSlow()`), quindi NON si risolve da sola.
**Prompt**: `Call the slow tool and tell me what it returns`
**Atteso**: il tool call resta in attesa; dopo 60+ secondi chiamare `window.resolveSlow('done')` dalla console e verificare che l'agente riceva il risultato.
**Da registrare**: quanto tempo il browser tiene viva la promessa? C'è un timeout? Quale errore arriva all'agente se scade?
- Se TENSIONE VIVA OLTRE 2 MINUTI → il flusso bloccante dell'approvazione è OK: Redini può aspettare l'utente dentro execute()
- Se TIMEOUT BREVE (<60s) → implementare l'ack immediato `pending_user_approval` + risposta al turno dopo

### Test 3 — Declarative form (form compilato dall'agente)
Setup: aggiungere temporaneamente in index.html un form di prova:
```html
<form toolname="test_booking" tooldescription="Books a table for testing" id="test-form">
  <input name="guest_name" toolparamdescription="Name of the guest" required>
  <input name="people" type="number" toolparamdescription="Number of people" required>
  <button type="submit">Book</button>
</form>
```
**Prompt**: `Book a table for 4 people under the name Rossi`
**Atteso**: l'agente compila i campi del form (senza toolautosubmit, il submit resta manuale); il form visualmente è compilato.
**Da registrare**: la compilazione avviene? I campi sono visibilmente riempiti? L'agente dice di attendere il submit umano?
- Se OK → procediamo con il form dichiarativo di checkout (Giorno 3)
- Se KO → fallback F1 (tool imperativo `fill_checkout_form` che compila i campi via JS, stessa UX di revisione)

### Test 4 — SubmitEvent.agentInvoked + respondWith
Setup: al form del Test 3 aggiungere un listener:
```js
document.getElementById('test-form').addEventListener('submit', (e) => {
  if (e.agentInvoked) { e.preventDefault(); e.respondWith(Promise.resolve({ status: 'booked' })); }
});
```
**Prompt**: ripetere il Test 3 e poi chiedere all'agente di inviare (`...and submit it`)
**Atteso**: l'agente preme submit (o lo richiede), il listener intercetta, la pagina NON naviga, l'agente riceve `{status:'booked'}`.
- Se OK → checkout con conferma strutturata all'agente (Giorno 3)
- Se KO → fallback F2 (`get_order_status`)

### Test 5 — tool dinamici e toolchange
Setup: registrare in main.ts un tool `add_note` che registra a sua volta `get_note_N` via controller dedicato + listener toolchange.
**Prompt**: `Add a note saying "hello"` poi `Read my note`
**Atteso**: dopo add_note, l'agente vede e chiama get_note_N.
- Se OK → le varianti dinamiche del design (Giorno 3) — **SUPERSEDED in v3**: niente varianti, la superficie è fissa a 5 tool (vedi nota storica sotto)
- Se KO → i tool restano statici; le varianti tornano dati nel result di create_variant — **SUPERSEDED in v3**: anche questo percorso è abbandonato (create_variant non esiste in v3)

### Test 6 — Deregistrazione via AbortController
Setup: tool `temp_echo` registrato con signal; un tool `dispose_temp` che chiama controller.abort().
**Prompt**: `Call temp echo with "hi"` → atteso: funziona. `Call dispose temp` poi di nuovo `call temp echo` → atteso: il tool non esiste più.
- Se OK → uscita pulita delle varianti (Giorno 3) — la parte "varianti" è **SUPERSEDED in v3** (niente varianti); la deregistrazione via AbortController resta in v3 per i tool safe

**Nota storica (v3)**: i piani "forward-looking" sotto — form dichiarativo di checkout, `fill_checkout_form`, `get_order_status`, `respondWith` per ordini — sono stati **SUPERSEDED**: v3 non ha checkout né ordini, il prodotto è la negoziazione del ChangeSet (vedi CONCEPT/TECHNICAL-DESIGN v3). Il Test 3/4 aveva valore solo come verifica tecnica di `agentInvoked`/`respondWith`; le decisioni di prodotto che ne derivavano sono state abbandonate in favore del tool changeset `design_update`.

## 3. Tabella risultati (da compilare)

| Test | ChatGPT in-app browser | Chrome 149+ flag | Decisione |
|---|---|---|---|
| 1 Pipeline base | ☐ (da fare con agente reale) | ✅ PASS (automatizzato) | — |
| 2 Timeout attesa umana (durata?) | ☐ | ✅ promessa viva >90s, risolta al resolve | ☑ approvazione bloccante |
| 3 Form dichiarativo compilato | ☐ | ✅ campi riempiti + tool pending | ☑ declarative |
| 4 respondWith | ☐ | ✅ submit umano chiude il tool con `{status:'booked'}`; `agentInvoked:true` | ☑ conferma strutturata |
| 5 tool dinamici + toolchange | ☐ | ✅ read_note_1 registrato + 1 evento | ☑ varianti dinamiche — **SUPERSEDED in v3** (superficie fissa a 5 tool) |
| 6 AbortController | ☐ | ✅ temp_echo rimosso | ☑ deregistrazione pulita |

Nota firma (verificata in v3): `executeTool(registeredTool, args)` richiede (1) l'**oggetto RegisteredTool restituito da `getTools()`** come primo argomento e (2) **args come STRINGA JSON** (oggetti → "Failed to parse input arguments"); la risposta arriva serializzata come stringa JSON. Script storico: `scripts/spike-auto.mjs` (rimosso — vedi nota in testa). Residuo: ripetere i test col browser in-app di ChatGPT (agente reale, ~10 min, prompt già pronti qui sopra).

La MINIMA barriera di partenza è il Test 1 su almeno uno dei due browser. Tutto il resto ha fallback.

## 4. Output dello spike

1. Tabella §3 compilata (entrambe le colonne)
2. Decisione su: approvazione bloccante vs ack pending; declarative vs F1
3. Queste decisioni cambiano SOLO l'implementazione del Giorno 2-3, non il piano
