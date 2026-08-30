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
import { AtelierStore } from './atelier/store';
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

// Demo mode: ?clean=1 hides human-only hints so the ONLY way for the agent to
// mutate the design is the WebMCP tool path.
if (new URLSearchParams(window.location.search).has('clean')) {
  document.querySelectorAll('.human-hint').forEach((el) => el.remove());
}

const store = new AtelierStore();
let atelierUi: { setGhost: (g: FlyerDesign | null) => void } | null = null;

function setGhost(ghost: FlyerDesign | null): void {
  atelierUi?.setGhost(ghost);
}

/**
 * Redini UI adapter: the DOM panel renders the ChangeSet negotiation cards and
 * the receipts; the canvas ghost shows the proposed result BEFORE it happens.
 */
const panel = createDomPanel({
  queueEl: document.getElementById('approval-queue')!,
  logEl: document.getElementById('activity-log')!,
  undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
});

const ui: UIAdapter & { bind?: (g: ReturnType<typeof createGuard>) => void } = {
  onChangesetUpdated(cs, preview) {
    panel.onChangesetUpdated(cs, preview);
    const ghost = (preview?.diff as { appliedPreview?: FlyerDesign } | undefined)?.appliedPreview ?? null;
    setGhost(cs.status === 'proposed' || cs.status === 'reviewing' ? ghost : null);
  },
  onReceipt(receipt: ChangeSetReceipt): void {
    panel.onReceipt(receipt);
  },
  onUndo(ev: UndoEvent): void {
    panel.onUndo(ev);
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
(window as unknown as { __guard: unknown }).__guard = guard; // console access for testing
registerAtelierTools(guard, store);

atelierUi = initAtelierUI(store, (templateId) => {
  // Human direct action: even this flows through a ChangeSet (dispatch +
  // immediate commit), so the audit trail records everything and pending agent
  // ChangeSets correctly go stale.
  const t = templates.find((x) => x.id === templateId);
  if (!t) return;
  const p = guard.dispatch('design_update', {
    intent: `Apply template "${t.name}"`,
    operations: [
      { kind: 'setFill', params: { target: 'background', value: t.design.background } },
      { kind: 'setFill', params: { target: 'text', value: t.design.color } },
      { kind: 'setFont', params: { value: t.design.fontFamily } },
    ],
  }) as Promise<unknown>;
  const csId = guard.getChangeSets().at(-1)!.id;
  p.then((o) => logEntry(`human action: ${JSON.stringify(o)}`)).catch(() => {});
  guard.commitChangeSet(csId).catch((e: unknown) => logEntry(e instanceof Error ? e.message : String(e)));
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
