import './styles.css';
import { createGuard } from './redini/index';
import { createDomPanel } from './redini/ui/dom-panel';
import type { AuditEntry, PreviewInfo, Receipt, Transaction, UIAdapter, UndoEvent } from './redini/index';
import type { FlyerDesign } from './atelier/store';
import { AtelierStore } from './atelier/store';
import { registerAtelierTools } from './atelier/tools';
import { initAtelierUI } from './atelier/ui';

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
  document.querySelectorAll('.spike-zone, .human-hint').forEach((el) => el.remove());
}

const store = new AtelierStore();
let atelierUi: { setGhost: (g: FlyerDesign | null) => void } | null = null;

function setGhost(ghost: FlyerDesign | null): void {
  atelierUi?.setGhost(ghost);
}

/**
 * Redini UI adapter: the DOM panel handles staging cards and the audit trail;
 * the canvas ghost shows proposals BEFORE they happen.
 */
const panel = createDomPanel({
  queueEl: document.getElementById('approval-queue')!,
  logEl: document.getElementById('activity-log')!,
  undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
});

const ui: UIAdapter & { bind?: (g: ReturnType<typeof createGuard>) => void } = {
  onTransactionUpdated(tx: Transaction, preview: PreviewInfo | null): void {
    panel.onTransactionUpdated(tx, preview);
    const ghost = (preview?.diff as { ghostDesign?: FlyerDesign } | undefined)?.ghostDesign ?? null;
    setGhost(tx.status === 'proposed' || tx.status === 'reviewing' ? ghost : null);
  },
  onReceipt(receipt: Receipt): void {
    panel.onReceipt(receipt);
  },
  onUndo(ev: UndoEvent): void {
    panel.onUndo(ev);
    setGhost(null);
  },
  onAudit(entry: AuditEntry): void {
    panel.onAudit(entry);
  },
  bind(g: ReturnType<typeof createGuard>): void {
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
  // Human direct action: it still flows through a transaction (dispatch +
  // immediate commit), so the audit trail records everything and pending agent
  // proposals correctly go stale.
  const p = guard.dispatch('apply_template', { templateId }) as Promise<unknown>;
  const txId = guard.getTransactions().at(-1)!.id;
  p.then((o) => logEntry(`human action: ${JSON.stringify(o)}`)).catch(() => {});
  guard.commit(txId).catch((e: unknown) => logEntry(e instanceof Error ? e.message : String(e)));
});

// Declarative checkout (spec-native staging): the agent fills the form,
// the human reviews and submits — always. No toolautosubmit.
const checkoutForm = document.getElementById('checkout-form') as HTMLFormElement | null;
checkoutForm?.addEventListener('submit', (e) => {
  const ev = e as SubmitEvent & { agentInvoked?: boolean; respondWith?: (p: Promise<unknown>) => void };
  e.preventDefault(); // the demo never navigates
  const data = new FormData(checkoutForm);
  const order = store.addOrder(Number(data.get('copies')), String(data.get('pageSize')));
  logEntry(`order placed via checkout form: ${order.id} (${order.copies}×${order.pageSize})`);
  if (ev.agentInvoked) {
    ev.respondWith?.(
      Promise.resolve({
        status: 'ordered',
        orderNumber: order.id,
        copies: order.copies,
        pageSize: order.pageSize,
      }),
    );
  }
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
