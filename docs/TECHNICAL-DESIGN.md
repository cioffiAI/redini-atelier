# TECHNICAL DESIGN — Redini + Atelier
Stato: BOZZA v0.1 — 29/08/2026

---

## 1. Architettura generale

```
┌─────────────────────────────────────────────────────┐
│  Atelier (app demo)                                 │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Design       │  │ Guardrail UI                 │ │
│  │ Canvas (SVG) │  │ - Approval queue panel       │ │
│  │ + stato      │  │ - Activity log               │ │
│  │              │  │ - Undo controls              │ │
│  └──────┬───────┘  └──────────────┬───────────────┘ │
│         │                         │                 │
│  ┌──────┴─────────────────────────┴───────────────┐ │
│  │ redini/ (libreria)                             │ │
│  │  - registerGuardedTool()                       │ │
│  │  - ApprovalQueue (stato + eventi)              │ │
│  │  - SnapshotStore + undo stack                  │ │
│  └──────────────────┬─────────────────────────────┘ │
└─────────────────────┼───────────────────────────────┘
                      │
        document.modelContext  (API WebMCP nativa)
                      │
              Browser agent (ChatGPT in-app browser /
              Chrome con chrome://flags/#enable-webmcp-testing)
```

Tre strati con responsabilità nette:
- **Atelier**: UI, dominio (design del flyer), integrazione redini.
- **redini/**: policy di approvazione, snapshot/undo, log. Zero conoscenza del dominio.
- **WebMCP nativo**: registrazione, discovery, esecuzione.

## 2. Stack tecnico

| Scelta | Motivo |
|---|---|
| **Vite + TypeScript + Vanilla TS** (niente React) | Massima trasparenza verso la API nativa (niente layer che nascondono `document.modelContext`), build statica pura → Netlify semplice, meno rischi in un progetto a 5 giorni. Decisione rivalutabile: se si preferisce React, `webmcp-react` esiste ma aggiunge un'astrazione che penalizza il criterio "Leverage". |
| **SVG per il canvas del flyer** | Editabile via DOM/attributi → le modifiche dell'agente sono semplice manipolazione di stato + re-render; niente canvas/ WebGL; screenshot facili per anteprime |
| **Stato: store minimale custom** (pub/sub, ~50 righe) | Snapshot con `structuredClone()`, undo = ripristino stato; niente Redux |
| **Nessun backend** | Tutto client-side: è il punto filosofico di WebMCP (strumenti nel browser). Dati prodotti/template mock in JSON locale |
| **Deploy: Netlify** (richiesti 3.000 crediti) | Statico, gratuito comunque, HTTPS automatico (WebMCP richiede secure context) |

## 3. Design della libreria `redini/`

### 3.1 API proposta

```ts
import { createGuard } from './redini';

const guard = createGuard({
  container: document.getElementById('guardrail-panel')!,
  onAction: (entry) => log(entry),   // hook opzionale
});

// Tool read-only: esecuzione immediata
guard.register({
  name: 'list_templates',
  description: 'Lists available flyer templates with id, name, style tags.',
  mode: 'safe',                          // ← gira subito
  inputSchema: { /* ... */ },
  execute: async (input) => store.listTemplates(input),
});

// Tool mutante: passa dalla coda di approvazione
guard.register({
  name: 'apply_edit',
  description: 'Applies a visual edit to the current flyer design.',
  mode: 'approval-required',             // ← coda
  inputSchema: { /* ... */ },
  describe: (input) => `Cambia il titolo in "${input.title}"`, // anteprima umana
  execute: async (input) => store.applyEdit(input),
});
```

### 3.2 Flusso di un tool `approval-required`

```
Agente chiama executeTool(apply_edit, args)
  → redini intercetta execute()
  → snapshot dello stato corrente (structuredClone)
  → richiesta in coda: { tool, args, descrizione, anteprima }
  → l'agente riceve SUBITO: { status: 'pending_user_approval', requestId }
  → UI mostra la card: [Approva] [Modifica parametri] [Rifiuta]
     ├─ Approva → execute reale → risposta MCP all'agente { status:'done', result }
     ├─ Modifica → form dei parametri → poi Approva
     └─ Rifiuta → risposta { status:'declined_by_user', motivo }
  → voce nel log attività (timestamp, esito)
  → undo disponibile (ripristino snapshot)
```

**Punto chiave di design**: la `execute()` registrata su `document.modelContext` resta asincrona e restituisce la promessa solo dopo la decisione umana. L'agente non sparisce: riceve una risposta strutturata qualunque sia l'esito. Se i tempi umani sono lunghi, si risponde prima con un ack `pending` e poi si usa il canale conversazionale (nel frattempo l'utente clicca). Decisione da validare nello spike del giorno 1 (quanto tempo tiene aperto un tool call il browser di ChatGPT?).

### 3.3 Snapshot e undo

- Prima di ogni azione mutante approvata: `snapshots.push(structuredClone(state))`.
- Undo: `state = snapshots.pop()` + re-render + voce di log "ripristinato".
- Limite: 50 snapshot (memoria), sufficienti per la sessione demo.
- Gli snapshot coprono SOLO lo stato dell'app (non il DOM): il render è derivato.

### 3.4 Log attività

Voce: `{ timestamp, tool, args, esito: approved|declined|modified|undone, durata }`.
Resa: pannello a tempo, ultima in alto, icone di stato. Il log è anche il materiale del video demo.

## 4. Inventario dei tool di Atelier

### Tool imperativi

| Tool | Mode | Scopo | Copre nella spec |
|---|---|---|---|
| `list_templates` | safe | Elenco template (id, nome, tag stile) | tool read-only |
| `get_current_design` | safe | Stato corrente del flyer | tool read-only |
| `filter_templates` | safe | Filtra per descrizione naturale | schema con stringa libera |
| `apply_edit` | approval | Modifica titolo/colori/font/layout | coda approvazione + snapshot |
| `create_variant` | approval | Duplica il design in una variante | registrazione dinamica (le varianti registrano tool propri) |
| `undo_last` | safe | Ripristina l'ultimo snapshot | mostra l'undo anche all'agente |

### Tool dichiarativo (form)

```html
<form toolname="order_prints"
      tooldescription="Orders the current flyer design for printing. Review the details and submit to confirm."
      id="checkout-form">
  <input name="copies" type="number" min="1" max="1000" required
         toolparamdescription="Number of copies to print (1-1000)">
  <select name="pageSize" required toolparamdescription="Paper size">
    <option>A4</option><option>Letter</option><option>Legal</option>
  </select>
  <button type="submit">Review & order</button>
</form>
```

**Niente `toolautosubmit`**: l'agente compila, la UI evidenzia il form, l'utente rivede e clicca. Al submit:

```js
checkoutForm.addEventListener('submit', (e) => {
  if (e.agentInvoked) {
    e.preventDefault();
    e.respondWith(orderPromise); // conferma strutturata all'agente senza navigare
  }
});
```

### Tool dinamici
`create_variant` registra un tool `select_variant_N` e un `toolchange` notifica l'agente. Quando una variante viene eliminata, il suo AbortController deregistra i tool collegati.

## 5. UI Atelier (scope deliberatamente minimo)

- Flyer = un `<svg>` (o blocco HTML stilizzato) con ~6 campi editabili: titolo, sottotitolo, data, colore sfondo, colore testo, font (3 scelte), clipart (4 scelte).
- Sidebar sinistra: galleria template (3-4 template mock).
- Sidebar destra: pannello guardrail (coda approvazione + log + undo).
- Nessuna ambizione di editor grafico reale: i campi si modificano tramite l'agente o direttamente (input normali), a dimostrare che umano e agente condividono lo stesso stato.

## 6. Piano di verifica browser (SPIKE — giorno 1, priorità assoluta)

Matrice da validare PRIMA di scrivere il resto:

| # | Test | Browser | Esito atteso | Fallback se fallisce |
|---|---|---|---|---|
| 1 | `registerTool` + chiamata da agente | ChatGPT in-app browser | tool eseguito | — (bloccante) |
| 2 | idem | Chrome 149 + flag | tool eseguito | usare solo ChatGPT browser |
| 3 | `execute()` asincrona che resta in attesa >30s (approvazione umana) | ChatGPT in-app browser | promessa ancora viva | ack immediato `pending` + chiusura conversazione con esito al turno dopo |
| 4 | Form dichiarativo `toolname` compilato dall'agente | entrambi | form riempito | fallback F1: tool imperativo `fill_checkout_form` che compila i campi via JS, stesso UX di revisione |
| 5 | `SubmitEvent.agentInvoked` + `respondWith` | entrambi | risposta arriva all'agente | fallback F2: il submit mostra una conferma a schermo, l'agente viene informato con un tool `get_order_status` |
| 6 | `toolchange` | entrambi | evento ricevuto | re-polling con `getTools()` ogni N secondi |
| 7 | Deregistrazione via AbortController | entrambi | tool sparisce | registrare tool con lo stesso nome sovrascrivendolo |

**Regola**: se il test 1 fallisce in entrambi i browser, il progetto non è consegnabile → si cambia strategia il giorno 1, non il giorno 4.

## 7. Rischi tecnici e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| API dichiarativa non implementata/instabile nei browser di test | media | medio | fallback F1/F2 sopra; il valore del progetto è nel guardrail, la declarative è il contorno |
| Timeout del tool call in attesa dell'umano | media | alto | spike giorno 1 (test 3); ack `pending` + risposta al turno successivo |
| Scope creep sull'editor di design | alta | alto | 6 campi fissi, 4 template, vietato aggiungere feature dopo il giorno 3 |
| Differenze tra spec e implementazione reale | media | medio | testare solo ciò che gira davvero; il README documenta anche i limiti trovati (è contenuto di valore per i giudici) |
| Netlify crediti non approvati in 24h | bassa | nullo | il piano free di Netlify basta e avanza per un sito statico |
| Errore umano: deploy rotto il giorno della deadline | media | alto | deploy automatico da git (Netlify) dal giorno 3; ogni push = ambiente verificato |

## 8. Struttura del repository

```
webmcp-hackaton/
├─ LICENSE                  # MIT (visibile in cima al repo — requisito regole)
├─ README.md                # pitch 30s + quickstart + pattern guardrail
├─ docs/                    # questi documenti
├─ src/
│  ├─ redini/               # libreria (autocontenuta, copiabile altrove)
│  │  ├─ index.ts
│  │  ├─ guard.ts
│  │  ├─ approval-queue.ts
│  │  ├─ snapshots.ts
│  │  └─ types.ts
│  ├─ atelier/              # app demo
│  │  ├─ main.ts
│  │  ├─ store.ts
│  │  ├─ tools.ts           # registrazione tool (imperativi + form)
│  │  ├─ templates.json
│  │  └─ ui/
│  └─ styles.css
├─ index.html
├─ package.json / vite.config.ts / tsconfig.json
└─ netlify.toml             # build config
```

## 9. Requisiti delle regole da rispettare (checklist tecnica)

- [ ] `document.modelContext.registerTool({ name, description, inputSchema, execute })` presente nel codice (le regole lo citano letteralmente).
- [ ] Licenza open source come file in radice, rilevabile nella sezione About del repo.
- [ ] Sito pubblico senza restrizioni fino alla fine del judging (21 set).
- [ ] Repo contiene tutto il necessario per farlo girare (`npm install && npm run dev`).
- [ ] Nessun materiale coperto da copyright nel video (musica inclusa).
- [ ] Materiali submission in inglese.
