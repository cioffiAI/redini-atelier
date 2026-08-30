import type { RediniGuard } from '../guard';
import type {
  AuditEntry,
  PreviewInfo,
  Receipt,
  Transaction,
  UIAdapter,
} from '../types';

export interface DomPanelOptions {
  /** Element that hosts the staging cards. */
  queueEl: HTMLElement;
  /** List that receives the audit trail entries. */
  logEl: HTMLElement;
  /** Button that triggers undo of the most recent receipt. */
  undoBtn?: HTMLButtonElement;
}

/**
 * Minimal DOM UI adapter. One card per transaction with:
 *   [Commit] [Edit] [Decline]
 * Edit switches the card to a JSON textarea; committing while reviewing uses the draft.
 */
export function createDomPanel(options: DomPanelOptions): UIAdapter & { bind(guard: RediniGuard): void } {
  const { queueEl, logEl, undoBtn } = options;
  const cards = new Map<string, HTMLElement>();
  const state = new Map<string, { tx: Transaction; preview: PreviewInfo | null; editing: boolean }>();
  const receipts: Receipt[] = [];
  const consumedTokens = new Set<string>();
  let guard: RediniGuard | null = null;
  let undoBusy = false;

  const ts = (): string => new Date().toLocaleTimeString();

  function logLine(text: string): void {
    const li = document.createElement('li');
    li.textContent = `${ts()} — ${text}`;
    logEl.prepend(li);
  }

  function updateUndoButton(): void {
    if (!undoBtn) return;
    const hasOpen = receipts.some((r) => !consumedTokens.has(r.undoToken));
    undoBtn.disabled = !hasOpen || undoBusy;
  }

  function renderCard(tx: Transaction, preview: PreviewInfo | null): void {
    let card = cards.get(tx.id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'tx-card';
      cards.set(tx.id, card);
      queueEl.querySelector('.empty')?.remove();
      queueEl.appendChild(card);
    }
    const st = state.get(tx.id);
    card.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'tx-head';
    const title = document.createElement('strong');
    title.textContent = tx.tool;
    const chip = document.createElement('span');
    chip.className = `tx-chip tx-${tx.status}`;
    chip.textContent = tx.status;
    head.append(title, chip);

    const body = document.createElement('div');
    body.className = 'tx-body';

    const proposed = document.createElement('div');
    proposed.className = 'tx-io';
    proposed.textContent = `proposed: ${JSON.stringify(tx.proposedInput)}`;
    body.appendChild(proposed);

    if (tx.committedInput) {
      const committed = document.createElement('div');
      committed.className = 'tx-io';
      committed.textContent = `committed: ${JSON.stringify(tx.committedInput)}`;
      body.appendChild(committed);
    }

    if (preview?.summary) {
      const p = document.createElement('div');
      p.className = 'tx-preview';
      p.textContent = preview.summary;
      body.appendChild(p);
    }

    card.append(head, body);

    if (st?.editing) {
      const area = document.createElement('textarea');
      area.className = 'tx-edit';
      const existingDraft = parseDraft(card);
      area.value = JSON.stringify(
        Object.keys(existingDraft).length > 0 ? existingDraft : tx.proposedInput,
        null,
        2,
      );
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const apply = document.createElement('button');
      apply.textContent = 'Apply edit';
      apply.addEventListener('click', () => {
        if (!guard) return;
        try {
          guard.editTransaction(tx.id, JSON.parse(area.value) as Record<string, unknown>);
        } catch (e) {
          logLine(`edit error: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel edit';
      cancel.addEventListener('click', () => {
        const current = state.get(tx.id);
        if (current) {
          current.editing = false;
          renderCard(current.tx, current.preview);
        }
      });
      actions.append(apply, cancel);
      card.append(area, actions);
      return;
    }

    if (tx.status === 'proposed' || tx.status === 'reviewing') {
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const commit = document.createElement('button');
      commit.className = 'tx-commit';
      commit.textContent = 'Commit';
      commit.addEventListener('click', () => {
        guard?.commit(tx.id).catch((e: unknown) => {
          logLine(e instanceof Error ? e.message : String(e));
        });
      });
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        const current = state.get(tx.id);
        if (current) {
          current.editing = true;
          renderCard(current.tx, current.preview);
        }
      });
      const decline = document.createElement('button');
      decline.className = 'tx-decline';
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => {
        guard?.decline(tx.id, 'declined from panel');
      });
      actions.append(commit, edit, decline);
      card.appendChild(actions);
    }
  }

  /** Reads the current textarea content of a card (used while reviewing). */
  function parseDraft(_card: HTMLElement): Record<string, unknown> {
    const area = _card.querySelector('.tx-edit') as HTMLTextAreaElement | null;
    if (area) {
      try {
        return JSON.parse(area.value) as Record<string, unknown>;
      } catch {
        /* fall through to empty */
      }
    }
    return {};
  }

  const adapter: UIAdapter & { bind(g: RediniGuard): void } = {
    onTransactionUpdated(tx, preview) {
      state.set(tx.id, {
        tx: structuredClone(tx),
        preview,
        editing: tx.status === 'reviewing',
      });
      renderCard(tx, preview);
    },
    onReceipt(receipt) {
      receipts.push({ ...receipt });
      logLine(`receipt ${receipt.transactionId} committed (${receipt.tool})`);
      updateUndoButton();
    },
    onUndo(ev) {
      consumedTokens.add(ev.undoToken);
      logLine(`rolled back ${ev.transactionId} (${ev.tool})`);
      updateUndoButton();
    },
    onAudit(entry: AuditEntry) {
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
      logLine(`${entry.kind} ${entry.tool} ${entry.txId}${detail}`);
    },
    bind(g: RediniGuard) {
      guard = g;
      undoBtn?.addEventListener('click', () => {
        const last = [...receipts].reverse().find((r) => !consumedTokens.has(r.undoToken));
        if (!last) return;
        undoBusy = true;
        updateUndoButton();
        g.undo(last.undoToken).catch((e: unknown) => {
          logLine(e instanceof Error ? e.message : String(e));
        }).finally(() => {
          undoBusy = false;
          updateUndoButton();
        });
      });
      updateUndoButton();
    },
  };

  return adapter;
}
