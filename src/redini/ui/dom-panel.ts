import type { RediniGuard } from '../guard';
import type {
  AuditEntry,
  ChangeSet,
  ChangeSetOperation,
  ChangeSetReceipt,
  ChangeSetStatus,
  PreviewInfo,
  UIAdapter,
} from '../types';

/** Per-parameter editing hints for the typed amendment forms (app-provided). */
export interface FieldHints {
  /** Allowed values for a select-style input (e.g. the app's real font options). */
  options?: string[];
  /** Inclusive bounds for a number input (e.g. the real canvas bounds). */
  min?: number;
  max?: number;
}

export interface DomPanelOptions {
  /** Element that hosts the ChangeSet cards. */
  queueEl: HTMLElement;
  /** List that receives the audit trail entries. */
  logEl: HTMLElement;
  /** Button that triggers undo of the most recent committed ChangeSet. */
  undoBtn?: HTMLButtonElement;
  /** Per-kind, per-param editing hints for the typed amendment forms. */
  editHints?: Record<string, Record<string, FieldHints>>;
}

interface CardState {
  cs: ChangeSet;
  preview: PreviewInfo | null;
  editingOpId: string | null;
}

/** Statuses where the card becomes a read-only chip: no live buttons/checkboxes. */
const TERMINAL_STATUSES: ChangeSetStatus[] = [
  'committed',
  'declined',
  'cancelled',
  'stale',
  'failed',
  'undone',
  'undo_failed',
];

/**
 * ChangeSet card UI — the negotiation surface:
 *   [✓] op label  (per-op: toggle inclusion, edit parameters via typed forms)
 *   [Commit N of M] [Decline]
 * After commit, the card renders the RECEIPT (intended / amended / skipped / applied).
 *
 * Safe-DOM invariant: no innerHTML interpolation of dynamic values — every
 * dynamic string goes through createElement/textContent (`innerHTML = ''`
 * clears are the only innerHTML usage). Errors never throw to the console:
 * they render inline in a .tx-error element.
 */
export function createDomPanel(options: DomPanelOptions): UIAdapter & { bind(guard: RediniGuard): void } {
  const { queueEl, logEl, undoBtn, editHints } = options;
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

  function showError(card: HTMLElement, e: unknown): void {
    let err = card.querySelector<HTMLElement>('.tx-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'tx-error';
      card.appendChild(err);
    }
    err.textContent = e instanceof Error ? e.message : String(e);
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
      for (const row of r.amended) {
        const was = row.originalLabel ?? JSON.stringify(row.originalParams ?? {});
        lines.push(`  ${row.id}. ${row.label}   (was: ${was})`);
      }
    }
    if (r.skippedByHuman.length > 0) {
      lines.push('');
      lines.push('SKIPPED BY HUMAN');
      for (const row of r.skippedByHuman) lines.push(`  ${row.id}. ${row.label}`);
    }
    lines.push('');
    lines.push('APPLIED (committed values)');
    for (const row of r.applied) lines.push(`  ${row.id}. ${row.label}`);
    lines.push('');
    lines.push(`STATE: v${r.stateVersionBefore} → v${r.stateVersionAfter}`);
    const undoAvailable = !consumedTokens.has(r.undoToken);
    lines.push(`UNDO: ${undoAvailable ? 'available' : 'used'}`);
    const pre = document.createElement('pre');
    pre.className = 'receipt-pre';
    pre.textContent = lines.join('\n');
    box.appendChild(pre);
    target.appendChild(box);
  }

  /**
   * Typed per-kind amendment form (FIX O): no raw JSON editing.
   * setText → text input; setFill → color + hex text input; setFont → select
   * with the app's real options; move → x/y number inputs with canvas bounds;
   * resize → size number input with real bounds.
   */
  function buildEditForm(op: ChangeSetOperation): { box: HTMLElement; collect: () => Record<string, unknown> } {
    const box = document.createElement('div');
    box.className = 'tx-edit-form';
    const fieldHints = (key: string): FieldHints => editHints?.[op.kind]?.[key] ?? {};

    const addTextInput = (key: string, value: string): HTMLInputElement => {
      const label = document.createElement('label');
      label.className = 'tx-edit-field';
      const span = document.createElement('span');
      span.textContent = key;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      label.append(span, input);
      box.appendChild(label);
      return input;
    };

    const addNumberInput = (key: string, value: number): HTMLInputElement => {
      const label = document.createElement('label');
      label.className = 'tx-edit-field';
      const span = document.createElement('span');
      span.textContent = key;
      const input = document.createElement('input');
      input.type = 'number';
      const hints = fieldHints(key);
      if (hints.min !== undefined) input.min = String(hints.min);
      if (hints.max !== undefined) input.max = String(hints.max);
      input.value = String(value);
      label.append(span, input);
      box.appendChild(label);
      return input;
    };

    switch (op.kind) {
      case 'setText': {
        const valueInput = addTextInput('value', String(op.params.value ?? ''));
        return {
          box,
          collect: () => ({ field: op.params.field, value: valueInput.value }),
        };
      }
      case 'setFill': {
        const current = String(op.params.value ?? '#000000');
        const base = /^#[0-9a-fA-F]{6}$/.test(current) ? current : '#000000';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        const sync = (from: HTMLInputElement, to: HTMLInputElement): void => {
          const v = from.value;
          if (/^#[0-9a-fA-F]{6}$/.test(v)) to.value = v;
        };
        colorInput.value = base;
        const textInput = addTextInput('value', base);
        colorInput.addEventListener('input', () => sync(colorInput, textInput));
        textInput.addEventListener('input', () => sync(textInput, colorInput));
        colorInput.className = 'tx-color';
        box.prepend(colorInput);
        return {
          box,
          collect: () => ({ target: op.params.target, value: textInput.value }),
        };
      }
      case 'setFont': {
        const label = document.createElement('label');
        label.className = 'tx-edit-field';
        const span = document.createElement('span');
        span.textContent = 'value';
        const select = document.createElement('select');
        const options = fieldHints('value').options ?? [];
        for (const opt of options) {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = opt;
          if (opt === String(op.params.value ?? '')) el.selected = true;
          select.appendChild(el);
        }
        label.append(span, select);
        box.appendChild(label);
        return {
          box,
          collect: () => ({ value: select.value }),
        };
      }
      case 'move': {
        const xInput = addNumberInput('x', Number(op.params.x ?? 0));
        const yInput = addNumberInput('y', Number(op.params.y ?? 0));
        return {
          box,
          collect: () => ({ x: Number(xInput.value), y: Number(yInput.value) }),
        };
      }
      case 'resize': {
        const sizeInput = addNumberInput('size', Number(op.params.size ?? 40));
        return {
          box,
          collect: () => ({ size: Number(sizeInput.value) }),
        };
      }
      default: {
        const note = document.createElement('span');
        note.className = 'tx-edit-note';
        note.textContent = `No editable parameters for operation kind "${op.kind}".`;
        box.appendChild(note);
        return {
          box,
          collect: () => ({ ...op.params }),
        };
      }
    }
  }

  function renderOpRow(
    card: HTMLElement,
    cs: ChangeSet,
    op: ChangeSetOperation,
    interactive: boolean,
  ): void {
    const row = document.createElement('div');
    row.className = 'tx-op';

    if (interactive) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = op.included;
      check.title = op.included ? 'Click to skip this operation' : 'Click to include this operation';
      check.addEventListener('change', () => {
        if (!guard) return;
        try {
          guard.toggleOperation(cs.id, op.id, check.checked);
        } catch (e) {
          check.checked = !check.checked;
          showError(card, e);
        }
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
      pen.className = 'op-amended-badge';
      pen.title = `Agent proposed: ${JSON.stringify(op.originalParams)}`;
      pen.textContent = ' ✎ amended';
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
      const form = buildEditForm(op);
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const save = document.createElement('button');
      save.className = 'tx-save';
      save.textContent = 'Save';
      save.addEventListener('click', () => {
        if (!guard) return;
        try {
          guard.amendOperation(cs.id, op.id, form.collect());
        } catch (e) {
          // FIX D: inline error, the form stays open, nothing is mutated.
          let err = form.box.querySelector<HTMLElement>('.tx-error');
          if (!err) {
            err = document.createElement('div');
            err.className = 'tx-error';
            form.box.appendChild(err);
          }
          err.textContent = e instanceof Error ? e.message : String(e);
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
      actions.append(save, cancel);
      form.box.appendChild(actions);
      card.appendChild(form.box);
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
    chip.textContent = cs.status === 'cancelled' ? 'cancelled' : cs.status;
    head.append(title, chip);

    const intent = document.createElement('div');
    intent.className = 'tx-intent';
    intent.textContent = `“${cs.intent}”`;

    const opsBox = document.createElement('div');
    opsBox.className = 'tx-ops';
    const interactive = !TERMINAL_STATUSES.includes(cs.status);
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
        if (!guard) return;
        // FIX D: errors (e.g. EMPTY_CHANGESET) render inline; never to console.
        guard.commitChangeSet(cs.id).catch((e: unknown) => showError(card, e));
      });
      const decline = document.createElement('button');
      decline.className = 'tx-decline';
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => {
        if (!guard) return;
        try {
          guard.declineChangeSet(cs.id, 'declined from panel');
        } catch (e) {
          showError(card, e);
        }
      });
      actions.append(commit, decline);
      card.appendChild(actions);
    }

    const receipt = receipts.get(cs.id);
    // MAJOR 2: a receipt must survive the failure paths — on undo_failed/failed
    // it is exactly when the human needs to see what was (not) applied. Render
    // it for ANY terminal status; proposed/reviewing cards have no receipt yet.
    if (receipt && TERMINAL_STATUSES.includes(cs.status)) {
      renderReceipt(card, receipt);
    }
  }

  const adapter: UIAdapter & { bind(g: RediniGuard): void } = {
    onChangesetUpdated(cs, preview) {
      const prev = states.get(cs.id);
      states.set(cs.id, {
        cs: structuredClone(cs),
        preview,
        editingOpId:
          cs.status === 'proposed' || cs.status === 'reviewing' ? (prev?.editingOpId ?? null) : null,
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
        const last = [...receipts.values()].reverse().find((r) => !consumedTokens.has(r.undoToken));
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
