import './styles.css';
import { createGuard } from './redini/index';
import { createDomPanel } from './redini/ui/dom-panel';
import type {
  AuditEntry,
  ChangeSetReceipt,
  UIAdapter,
  UndoEvent,
} from './redini/index';
import type { FlyerDesign } from './atelier/store';
import { AtelierStore, CANVAS_H, CANVAS_W, FONT_OPTIONS } from './atelier/store';
import { registerAtelierTools } from './atelier/tools';
import { initAtelierUI } from './atelier/ui';
import { templates } from './atelier/templates';

const statusEl = document.getElementById('webmcp-status')!;

function logEntry(text: string): void {
  const ul = document.getElementById('activity-log')!;
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  ul.prepend(li);
}

const params = new URLSearchParams(window.location.search);
// Demo mode: ?clean=1 (any value other than '0') hides human-only hints, so
// agent-side mutation happens only through the WebMCP design_update tool path.
const clean = params.has('clean') && params.get('clean') !== '0';
const debug = params.has('debug') && params.get('debug') !== '0';

if (clean) {
  document.querySelectorAll('.human-hint').forEach((el) => el.remove());
}

const store = new AtelierStore();
let atelierUi: { setGhost: (g: FlyerDesign | null) => void } | null = null;
/** Which ChangeSet painted the ghost — only IT may clear it (FIX D). */
let ghostOwner: string | null = null;

function setGhost(ghost: FlyerDesign | null): void {
  atelierUi?.setGhost(ghost);
}

/**
 * Redini UI adapter: the DOM panel renders the ChangeSet negotiation cards and
 * the receipts; the canvas ghost shows the proposed result BEFORE it happens.
 */
const panel = createDomPanel({
  queueEl: document.getElementById('change-queue')!,
  logEl: document.getElementById('activity-log')!,
  undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
  // Typed amendment controls: the app's REAL options and canvas bounds.
  editHints: {
    setFont: { value: { options: FONT_OPTIONS } },
    move: { x: { min: 0, max: CANVAS_W }, y: { min: 0, max: CANVAS_H } },
    resize: { size: { min: 16, max: 200 } },
  },
});

const ui: UIAdapter & { bind?: (g: ReturnType<typeof createGuard>) => void } = {
  onChangesetUpdated(cs, preview) {
    panel.onChangesetUpdated(cs, preview);
    const ghost = (preview?.diff as { appliedPreview?: FlyerDesign } | undefined)?.appliedPreview ?? null;
    if (cs.status === 'proposed' || cs.status === 'reviewing') {
      ghostOwner = cs.id;
      setGhost(ghost);
    } else if (ghostOwner === cs.id) {
      // The ChangeSet that painted the ghost reached a terminal status → clear it.
      ghostOwner = null;
      setGhost(null);
    }
  },
  onReceipt(receipt: ChangeSetReceipt): void {
    panel.onReceipt(receipt);
  },
  onUndo(ev: UndoEvent): void {
    panel.onUndo(ev);
    ghostOwner = null;
    setGhost(null);
  },
  onAudit(entry: AuditEntry): void {
    panel.onAudit(entry);
  },
  bind(g) {
    panel.bind(g);
  },
};

// document.modelContext is available synchronously: create the guard with it
// right away, so every registration lands in the live model context exactly once.
const mc = document.modelContext;
const guard = createGuard({ ui, modelContext: mc ?? null });
// Console access ONLY for debugging: ?debug=1 (the e2e drives the REAL WebMCP
// executeTool path and must not depend on this handle).
if (debug) {
  (window as unknown as { __guard: unknown }).__guard = guard;
}
registerAtelierTools(guard, store);

atelierUi = initAtelierUI(store, (templateId) => {
  // Human direct action: even this flows through a ChangeSet (dispatch +
  // immediate commit), so the audit trail records everything and pending agent
  // ChangeSets correctly go stale.
  const t = templates.find((x) => x.id === templateId);
  if (!t) return;
  const intent = `Apply template "${t.name}"`;
  const p = guard.dispatch('design_update', {
    intent,
    operations: [
      { kind: 'setFill', params: { target: 'background', value: t.design.background } },
      { kind: 'setFill', params: { target: 'text', value: t.design.color } },
      { kind: 'setFont', params: { value: t.design.fontFamily } },
    ],
  }) as Promise<unknown>;
  // MAJOR 3: if dispatch rejects (validation), there is NO ChangeSet to commit —
  // never guess with `.at(-1)`. Locate the staged ChangeSet deterministically:
  // the most recent one with THIS intent that is still pending.
  p.then((o) => logEntry(`human action: ${JSON.stringify(o)}`)).catch((e: unknown) =>
    console.error('[atelier] template dispatch failed:', e),
  );
  const cs = [...guard.getChangeSets()]
    .reverse()
    .find((c) => c.intent === intent && (c.status === 'proposed' || c.status === 'reviewing'));
  if (!cs) return;
  guard.commitChangeSet(cs.id).catch((e: unknown) => logEntry(e instanceof Error ? e.message : String(e)));
});

void (async (): Promise<void> => {
  if (!mc) {
    statusEl.textContent = 'WebMCP not available in this browser';
    statusEl.classList.add('ko');
    return;
  }

  statusEl.textContent = 'WebMCP available';

  // Diagnostics: full registered-tool count, visible without devtools.
  await new Promise((r) => setTimeout(r, 200));
  const registered = await mc.getTools().catch(() => [] as { name: string }[]);
  statusEl.textContent = `WebMCP available · ${registered.length} tools`;
  logEntry(`tools registered: ${registered.map((t) => t.name).join(', ') || 'NONE'}`);
})();
