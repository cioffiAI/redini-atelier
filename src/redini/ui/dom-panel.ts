import type { RediniGuard } from '../guard';
import type {
  AuditEntry,
  ChangeSet,
  ChangeSetOperation,
  ChangeSetReceipt,
  PreviewInfo,
  UIAdapter,
} from '../types';

export interface DomPanelOptions {
  /** Element that hosts the ChangeSet cards. */
  queueEl: HTMLElement;
  /** List that receives the audit trail entries. */
  logEl: HTMLElement;
  /** Button that triggers undo of the most recent committed ChangeSet. */
  undoBtn?: HTMLButtonElement;
}

interface CardState {
  cs: ChangeSet;
  preview: PreviewInfo | null;
  editingOpId: string | null;
}

/**
 * ChangeSet card UI — the negotiation surface:
 *   [✓] op label  (per-op: toggle inclusion, amend parameters)
 *   [Commit N of M] [Decline]
 * After commit, the card renders the RECEIPT (intended / amended / skipped / applied).
 */
export function createDomPanel(options: DomPanelOptions): UIAdapter & { bind(guard: RediniGuard): void } {
  const { queueEl, logEl, undoBtn } = options;
  const cards = new Map<string, HTMLElement>();
  const states = new Map<string, CardState>();
  const receipts = new Map<string, ChangeSetReceipt>();
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
    const hasOpen = [...receipts.values()].some((r) => !consumedTokens.has(r.undoToken));
    undoBtn.disabled = !hasOpen || undoBusy;
  }

  function renderReceipt(target: HTMLElement, r: ChangeSetReceipt): void {
    const box = document.createElement('div');
    box.className = 'receipt';
    const lines: string[] = [];
    lines.push(`RECEIPT #${r.transactionId.slice(0, 8)}`);
    lines.push('');
    lines.push('INTENDED');
    for (const row of r.intended) lines.push(`  ${row.id}. ${row.label}`);
    if (r.amended.length > 0) {
      lines.push('');
      lines.push('AMENDED BY HUMAN');
      for (const row of r.amended) lines.push(`  ${row.id}. ${row.label}`);
    }
    if (r.skippedByHuman.length > 0) {
      lines.push('');
      lines.push('SKIPPED BY HUMAN');
      for (const row of r.skippedByHuman) lines.push(`  ${row.id}. ${row.label}`);
    }
    lines.push('');
    lines.push(`APPLIED: ${r.applied.join(', ')}`);
    lines.push(`STATE: v${r.stateVersionBefore} → v${r.stateVersionAfter}`);
    const undoAvailable = !consumedTokens.has(r.undoToken);
    lines.push(`UNDO: ${undoAvailable ? 'available' : 'used'}`);
    const pre = document.createElement('pre');
    pre.className = 'receipt-pre';
    pre.textContent = lines.join('\n');
    box.appendChild(pre);
    target.appendChild(box);
  }

  function renderOpRow(card: HTMLElement, cs: ChangeSet, op: ChangeSetOperation, interactive: boolean): void {
    const row = document.createElement('div');
    row.className = 'tx-op';

    if (interactive) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = op.included;
      check.title = op.included ? 'Click to skip this operation' : 'Click to include this operation';
      check.addEventListener('change', () => {
        guard?.toggleOperation(cs.id, op.id, check.checked);
      });
      row.appendChild(check);
    } else {
      const mark = document.createElement('span');
      mark.className = `op-mark op-${op.status}`;
      mark.textContent = op.status === 'applied' ? '✓' : op.status === 'failed' ? '✗' : op.included ? '✓' : '—';
      row.appendChild(mark);
    }

    const label = document.createElement('span');
    label.className = 'op-label';
    label.textContent = op.label;
    if (op.amended) {
      const pen = document.createElement('span');
      pen.className = 'op-amended';
      pen.title = `Agent proposed: ${JSON.stringify(op.originalParams)}`;
      pen.textContent = ' ✎';
      label.appendChild(pen);
    }
    row.appendChild(label);

    if (interactive) {
      const edit = document.createElement('button');
      edit.className = 'op-edit-btn';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        const st = states.get(cs.id);
        if (st) {
          st.editingOpId = st.editingOpId === op.id ? null : op.id;
          renderCard(cs, st.preview);
        }
      });
      row.appendChild(edit);
    }
    card.appendChild(row);

    const st = states.get(cs.id);
    if (interactive && st?.editingOpId === op.id) {
      const area = document.createElement('textarea');
      area.className = 'tx-edit';
      area.value = JSON.stringify(op.params, null, 2);
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const apply = document.createElement('button');
      apply.textContent = 'Apply amendment';
      apply.addEventListener('click', () => {
        if (!guard) return;
        try {
          guard.amendOperation(cs.id, op.id, JSON.parse(area.value) as Record<string, unknown>);
        } catch (e) {
          logLine(`amendment error: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        const cur = states.get(cs.id);
        if (cur) {
          cur.editingOpId = null;
          renderCard(cs, cur.preview);
        }
      });
      actions.append(apply, cancel);
      card.append(area, actions);
    }
  }

  function renderCard(cs: ChangeSet, _preview: PreviewInfo | null): void {
    let card = cards.get(cs.id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'tx-card';
      cards.set(cs.id, card);
      queueEl.querySelector('.empty')?.remove();
      queueEl.appendChild(card);
    }
    card.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'tx-head';
    const title = document.createElement('strong');
    title.textContent = cs.tool;
    const chip = document.createElement('span');
    chip.className = `tx-chip tx-${cs.status}`;
    chip.textContent = cs.status;
    head.append(title, chip);

    const intent = document.createElement('div');
    intent.className = 'tx-intent';
    intent.textContent = `“${cs.intent}”`;

    const opsBox = document.createElement('div');
    opsBox.className = 'tx-ops';
    const interactive = cs.status === 'proposed' || cs.status === 'reviewing';
    for (const op of cs.operations) renderOpRow(opsBox, cs, op, interactive);

    card.append(head, intent, opsBox);

    if (interactive) {
      const includedCount = cs.operations.filter((o) => o.included).length;
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const commit = document.createElement('button');
      commit.className = 'tx-commit';
      commit.textContent = `Commit ${includedCount} of ${cs.operations.length}`;
      commit.addEventListener('click', () => {
        guard?.commitChangeSet(cs.id).catch((e: unknown) => {
          logLine(e instanceof Error ? e.message : String(e));
        });
      });
      const decline = document.createElement('button');
      decline.className = 'tx-decline';
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => {
        guard?.declineChangeSet(cs.id, 'declined from panel');
      });
      actions.append(commit, decline);
      card.appendChild(actions);
    }

    const receipt = receipts.get(cs.id);
    if (receipt && (cs.status === 'committed' || cs.status === 'undone')) {
      renderReceipt(card, receipt);
    }
  }

  const adapter: UIAdapter & { bind(g: RediniGuard): void } = {
    onChangesetUpdated(cs, preview) {
      const prev = states.get(cs.id);
      states.set(cs.id, {
        cs: structuredClone(cs),
        preview,
        editingOpId: cs.status === 'reviewing' ? (prev?.editingOpId ?? null) : null,
      });
      renderCard(cs, preview);
    },
    onReceipt(receipt) {
      receipts.set(receipt.transactionId, structuredClone(receipt));
      logLine(
        `receipt ${receipt.transactionId.slice(0, 8)} — applied ${receipt.applied.length}/${receipt.intended.length}` +
          (receipt.amended.length ? `, ${receipt.amended.length} amended` : '') +
          (receipt.skippedByHuman.length ? `, ${receipt.skippedByHuman.length} skipped` : ''),
      );
      updateUndoButton();
    },
    onUndo(ev) {
      consumedTokens.add(ev.undoToken);
      logLine(`rolled back ${ev.transactionId.slice(0, 8)} (${ev.tool})`);
      updateUndoButton();
    },
    onAudit(entry: AuditEntry) {
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
      logLine(`${entry.kind} ${entry.tool} ${entry.txId.slice(0, 8)}${detail}`);
    },
    bind(g: RediniGuard) {
      guard = g;
      undoBtn?.addEventListener('click', () => {
        const last = [...receipts.values()]
          .reverse()
          .find((r) => !consumedTokens.has(r.undoToken));
        if (!last) return;
        undoBusy = true;
        updateUndoButton();
        g.undo(last.undoToken)
          .catch((e: unknown) => logLine(e instanceof Error ? e.message : String(e)))
          .finally(() => {
            undoBusy = false;
            updateUndoButton();
          });
      });
      updateUndoButton();
    },
  };

  return adapter;
}
