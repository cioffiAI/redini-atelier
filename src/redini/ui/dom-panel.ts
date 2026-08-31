import { RediniError } from '../errors';
import type { RediniGuard } from '../guard';
import { DECIDED_CHANGESET_STATUSES } from '../types';
import type {
  AuditEntry,
  ChangeSet,
  ChangeSetOperation,
  ChangeSetReceipt,
  PreviewInfo,
  ReceiptRow,
  RedoEvent,
  UIAdapter,
  UndoEvent,
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
  /** List that receives the human-readable activity lines. */
  logEl: HTMLElement;
  /**
   * List that receives raw/diagnostic lines (ids, tool names, JSON) — render it
   * inside a collapsed "Developer details" block. Optional: apps without a dev
   * surface simply skip it.
   */
  devLogEl?: HTMLElement;
  /** Button that triggers undo of the most recently committed ChangeSet. */
  undoBtn?: HTMLButtonElement;
  /** Button that triggers redo of the most recently undone ChangeSet. */
  redoBtn?: HTMLButtonElement;
  /** Per-kind, per-param editing hints for the typed amendment forms. */
  editHints?: Record<string, Record<string, FieldHints>>;
  /**
   * App-provided human heading for an operation, e.g. "Title" or "Background".
   * FALLBACK when absent: the tool's describeOperation label (current behavior),
   * so the panel works for any app.
   */
  opHeading?: (op: { kind: string; params: Record<string, unknown> }) => string;
  /**
   * App-provided human rendering of an operation's value, e.g. `"${value}"` or
   * `${x}, ${y}`. FALLBACK when absent: empty (rows show the heading only).
   */
  formatValue?: (op: { kind: string; params: Record<string, unknown> }) => string;
}

interface CardState {
  cs: ChangeSet;
  preview: PreviewInfo | null;
  editingOpId: string | null;
}

/** Statuses where the card becomes a read-only chip: no live buttons/checkboxes. */
const TERMINAL_STATUSES = DECIDED_CHANGESET_STATUSES;

/** Human status chip labels (data unchanged — rendering only). */
const STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  reviewing: 'In review',
  committed: 'Committed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  stale: 'Stale',
  failed: 'Failed',
  undone: 'Undone',
  undo_failed: 'Undo failed',
};

/** User-facing error copy keyed by the technical code (section 7). */
const ERROR_MESSAGES: Record<string, string> = {
  INVALID_AMENDMENT: "Couldn't update this value — check the input.",
  EMPTY_CHANGESET: 'Every change was skipped — nothing to commit.',
  STALE_TRANSACTION:
    'The poster changed while this proposal was being reviewed. Ask the agent for a fresh proposal.',
  // EXECUTION_FAILED is state-uncertain BY CONSTRUCTION: an apply was attempted
  // and did not complete — it may have mutated state without returning an
  // inverse — so the poster may be partially updated. The UI never claims
  // "nothing happened" without certainty.
  EXECUTION_FAILED:
    "A change couldn't be fully applied — the poster may be in a partially updated state.",
  ROLLBACK_FAILED: 'Some changes could not be fully restored. See developer details.',
  UNDO_FAILED: 'Undo failed partway — you can try again.',
  REDO_FAILED: 'Redo failed partway — you can try again.',
  NOTHING_TO_UNDO: 'Nothing to undo.',
  NOTHING_TO_REDO: 'Nothing to redo.',
  ALREADY_DECIDED: 'This proposal was already decided.',
};

export function errorCodeOf(e: unknown): string | null {
  if (e instanceof RediniError) return e.code;
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return null;
}

/** Human-first error text; unknown codes fall back to the raw message (honest). */
export function humanizeError(e: unknown): string {
  const code = errorCodeOf(e);
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return e instanceof Error ? e.message : String(e);
}

/**
 * ChangeSet card UI — the negotiation surface:
 *   [✓] Heading  old → new  [Edit]  (per-op: toggle inclusion, edit parameters)
 *   [Commit N changes] [Decline]
 * After commit, the card renders the RECEIPT (intended / amended by you /
 * skipped by you / applied) with the technical bits collapsed in
 * "Developer details".
 *
 * Safe-DOM invariant: no innerHTML interpolation of dynamic values — every
 * dynamic string goes through createElement/textContent (`innerHTML = ''`
 * clears are the only innerHTML usage). Errors never throw to the console:
 * they render inline in a .tx-error element.
 */
export function createDomPanel(
  options: DomPanelOptions,
): UIAdapter & { bind(guard: RediniGuard): void; renderHistoryError(e: unknown): void } {
  const { queueEl, logEl, devLogEl, undoBtn, redoBtn, editHints, opHeading, formatValue } = options;
  const cards = new Map<string, HTMLElement>();
  const states = new Map<string, CardState>();
  const receipts = new Map<string, ChangeSetReceipt>();
  let guard: RediniGuard | null = null;
  let undoBusy = false;
  let redoBusy = false;

  const ts = (): string => new Date().toLocaleTimeString();

  /** Human-readable heading; falls back to the describeOperation label. */
  const headingOf = (kind: string, params: Record<string, unknown>, fallback: string): string =>
    opHeading ? opHeading({ kind, params }) : fallback;

  /** Human-readable value; falls back to '' when the app provides no hints. */
  const valueOf = (kind: string, params: Record<string, unknown>): string =>
    formatValue ? formatValue({ kind, params }) : '';

  // ---------- logs: user-facing activity vs technical developer details ----------

  function logActivity(text: string): void {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = ts();
    const body = document.createElement('span');
    body.className = 'activity-body';
    body.textContent = text;
    li.append(time, body);
    logEl.prepend(li);
  }

  function logDev(text: string): void {
    if (!devLogEl) return;
    const li = document.createElement('li');
    li.textContent = `${ts()} — ${text}`;
    devLogEl.prepend(li);
  }

  /** User-facing activity line for an audit entry — no tool names, ids or JSON. */
  function humanizeAudit(entry: AuditEntry): string {
    const ops = states.get(entry.txId)?.cs.operations ?? null;
    const opOf = (): ChangeSetOperation | null => {
      const id = entry.detail?.op;
      if (typeof id !== 'string' || !ops) return null;
      return ops.find((o) => o.id === id) ?? null;
    };
    switch (entry.kind) {
      case 'proposed': {
        const n = ops?.length ?? null;
        // Human-originated proposals (e.g. template clicks) are staged by the
        // person, not the agent — the intent comes from the panel's own card
        // data, the same lookup the agent line uses for N.
        if (entry.actor === 'human') {
          const intent = states.get(entry.txId)?.cs.intent ?? null;
          return intent ? `You staged ${intent}` : 'You staged a proposal';
        }
        return n === null ? 'Agent proposed a new proposal' : `Agent proposed ${n} change${n === 1 ? '' : 's'}`;
      }
      case 'reviewing': {
        const op = opOf();
        const heading = op ? headingOf(op.kind, op.params, op.label) : null;
        const toggled = entry.detail?.toggled;
        if (toggled === 'skipped') return heading ? `You skipped ${heading}` : 'You skipped an operation';
        if (toggled === 'included') return heading ? `You re-included ${heading}` : 'You re-included an operation';
        return heading ? `You amended ${heading}` : 'You edited the proposal';
      }
      case 'committed': {
        const applied = Number(entry.detail?.applied ?? 0);
        const skipped = Number(entry.detail?.skipped ?? 0);
        const total = applied + skipped;
        if (total === 0) return 'Committed';
        if (total === 1) return 'Committed the change';
        return `Committed ${applied} of ${total} changes`;
      }
      case 'declined':
        return 'Declined the proposal';
      case 'undone': {
        // Detail comes from the real undo event: the entry's inverse count.
        const n = Number(entry.detail?.operations ?? 0);
        return n > 0 ? `Undone · ${n} change${n === 1 ? '' : 's'} restored` : 'Undone';
      }
      case 'redone': {
        // Detail comes from the real redo event: the replayed forward count.
        const n = Number(entry.detail?.applied ?? 0);
        return n > 0 ? `Redone · ${n} change${n === 1 ? '' : 's'} reapplied` : 'Redone';
      }
      case 'stale':
        return 'Proposal expired';
      case 'cancelled':
        return 'Cancelled';
      case 'failed':
        // EXECUTION_FAILED is ALWAYS state-uncertain by construction (an apply
        // was attempted and did not complete — the poster may be partially
        // updated). ROLLBACK_FAILED keeps its own copy via the audit detail.
        return entry.detail?.rollbackFailed === true
          ? ERROR_MESSAGES.ROLLBACK_FAILED
          : ERROR_MESSAGES.EXECUTION_FAILED;
      case 'undo_failed':
        return 'Undo failed partway — you can try again.';
      case 'redo_failed':
        return 'Redo failed partway — you can try again.';
      default:
        return entry.kind;
    }
  }

  // ---------- errors ----------

  function renderErrorInto(err: HTMLElement, e: unknown, humanMsg?: string): void {
    err.textContent = '';
    const msg = document.createElement('span');
    msg.className = 'err-msg';
    msg.textContent = humanMsg ?? humanizeError(e);
    err.appendChild(msg);
    const code = errorCodeOf(e);
    if (code) {
      const c = document.createElement('span');
      c.className = 'err-code';
      // The code is for the eyes/devs: visually bracketed, and kept out of the
      // screen-reader text — the human message carries the meaning.
      c.setAttribute('aria-hidden', 'true');
      c.textContent = ` [${code}]`;
      err.appendChild(c);
    }
  }

  function showError(card: HTMLElement, e: unknown, humanMsg?: string): void {
    let err = card.querySelector<HTMLElement>('.tx-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'tx-error';
      card.appendChild(err);
    }
    renderErrorInto(err, e, humanMsg);
  }

  function updateHistoryButtons(): void {
    if (!guard) return;
    if (undoBtn) undoBtn.disabled = !guard.canUndo() || undoBusy;
    if (redoBtn) redoBtn.disabled = !guard.canRedo() || redoBusy;
  }

  /** History errors (buttons AND keyboard) render into ONE surface: the .tx-error hosted by the history controls. */
  function showHistoryError(e: unknown): void {
    const host = undoBtn?.parentElement ?? redoBtn?.parentElement;
    if (!host) return;
    let err = host.querySelector<HTMLElement>('.tx-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'tx-error';
      host.appendChild(err);
    }
    renderErrorInto(err, e);
  }

  function clearHistoryError(): void {
    const host = undoBtn?.parentElement ?? redoBtn?.parentElement;
    host?.querySelector<HTMLElement>('.tx-error')?.remove();
  }

  // ---------- receipt ----------

  function renderReceipt(target: HTMLElement, r: ChangeSetReceipt): void {
    const box = document.createElement('div');
    box.className = 'receipt';

    const plural = (n: number): string => (n === 1 ? 'change' : 'changes');

    const section = (title: string, count: string): HTMLElement => {
      const sec = document.createElement('div');
      sec.className = 'receipt-section';
      const head = document.createElement('div');
      head.className = 'receipt-heading';
      const t = document.createElement('span');
      t.className = 'receipt-title';
      t.textContent = title;
      const c = document.createElement('span');
      c.className = 'receipt-count';
      c.textContent = count;
      head.append(t, c);
      sec.appendChild(head);
      box.appendChild(sec);
      return sec;
    };

    const row = (
      sec: HTMLElement,
      mark: string,
      rowData: ReceiptRow,
      value: string,
    ): void => {
      const rw = document.createElement('div');
      rw.className = 'receipt-row';
      if (mark) {
        const m = document.createElement('span');
        m.className = 'receipt-mark';
        m.textContent = mark;
        rw.appendChild(m);
      }
      const txt = document.createElement('span');
      txt.className = 'receipt-text';
      txt.textContent = `${headingOf(rowData.kind, rowData.params, rowData.label)}${value ? ` · ${value}` : ''}`;
      rw.appendChild(txt);
      sec.appendChild(rw);
    };

    const valueLine = (rd: ReceiptRow, useOriginal: boolean): string => {
      const params = useOriginal && rd.originalParams ? rd.originalParams : rd.params;
      return valueOf(rd.kind, params);
    };

    const secIntended = section('Intended', `${r.intended.length} ${plural(r.intended.length)} proposed by the agent`);
    for (const it of r.intended) row(secIntended, '', it, valueLine(it, true));

    if (r.amended.length > 0) {
      const secAmended = section('Amended by you', `${r.amended.length} changed by you`);
      for (const a of r.amended) {
        const before = valueLine(a, true);
        const after = valueOf(a.kind, a.params);
        const line = before && after ? `${before} → ${after}` : `${a.label}${a.originalLabel ? ` (was: ${a.originalLabel})` : ''}`;
        row(secAmended, '', a, line);
      }
    }

    if (r.skippedByHuman.length > 0) {
      const secSkipped = section('Skipped by you', `${r.skippedByHuman.length} excluded`);
      for (const s of r.skippedByHuman) row(secSkipped, '', s, valueLine(s, false));
    }

    const secApplied = section('Applied', `${r.applied.length} ${plural(r.applied.length)} committed`);
    for (const a of r.applied) row(secApplied, '✓', a, valueLine(a, false));

    const footer = document.createElement('div');
    footer.className = 'receipt-footer';
    footer.textContent = `State v${r.stateVersionBefore} → v${r.stateVersionAfter}`;
    box.appendChild(footer);

    // Technical bits stay honest but out of the way: collapsed developer details.
    const details = document.createElement('details');
    details.className = 'dev-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Developer details';
    details.appendChild(summary);
    const dl = document.createElement('dl');
    const pairs: Array<[string, string]> = [
      ['Receipt', r.transactionId],
      ['ChangeSet tool', r.tool],
      ['Intent', r.intent],
      ['Operation ids', [...r.intended.map((x) => x.id), ...r.amended.map((x) => x.id), ...r.skippedByHuman.map((x) => x.id)].join(', ')],
      ['Proposed', new Date(r.proposedAt).toLocaleString()],
      ['Committed', new Date(r.committedAt).toLocaleString()],
    ];
    for (const [term, def] of pairs) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = def;
      dl.append(dt, dd);
    }
    details.appendChild(dl);
    box.appendChild(details);

    target.appendChild(box);
  }

  /**
   * Typed per-kind amendment form (FIX O): no raw JSON editing.
   * setText → text input; setFill → color + hex text input; setFont → select
   * with the app's real options; move → x/y number inputs with canvas bounds;
   * resize → size number input with real bounds. Human field labels only.
   */
  function buildEditForm(op: ChangeSetOperation): { box: HTMLElement; collect: () => Record<string, unknown> } {
    const box = document.createElement('div');
    box.className = 'tx-edit-form';
    const fieldHints = (key: string): FieldHints => editHints?.[op.kind]?.[key] ?? {};

    const head = document.createElement('div');
    head.className = 'tx-edit-heading';
    head.textContent = headingOf(op.kind, op.params, op.label);
    box.appendChild(head);

    const originalLine = document.createElement('div');
    originalLine.className = 'tx-edit-original';
    const agentValue = formatValue ? valueOf(op.kind, op.originalParams) : op.originalLabel;
    originalLine.textContent = `Agent proposed: ${agentValue}`;
    box.appendChild(originalLine);

    const addTextField = (labelText: string, value: string): HTMLInputElement => {
      const label = document.createElement('label');
      label.className = 'tx-edit-field';
      const span = document.createElement('span');
      span.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      label.append(span, input);
      box.appendChild(label);
      return input;
    };

    const addNumberField = (labelText: string, key: string, value: number): HTMLInputElement => {
      const label = document.createElement('label');
      label.className = 'tx-edit-field';
      const span = document.createElement('span');
      span.textContent = labelText;
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
        const valueInput = addTextField('Your value', String(op.params.value ?? ''));
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
        colorInput.className = 'tx-color';
        colorInput.value = base;
        const label = document.createElement('label');
        label.className = 'tx-edit-field tx-edit-field-inline';
        const span = document.createElement('span');
        span.textContent = 'Your value';
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.value = base;
        const sync = (from: HTMLInputElement, to: HTMLInputElement): void => {
          const v = from.value;
          if (/^#[0-9a-fA-F]{6}$/.test(v)) to.value = v;
        };
        colorInput.addEventListener('input', () => sync(colorInput, textInput));
        textInput.addEventListener('input', () => sync(textInput, colorInput));
        label.append(span, colorInput, textInput);
        box.appendChild(label);
        return {
          box,
          collect: () => ({ target: op.params.target, value: textInput.value }),
        };
      }
      case 'setFont': {
        const label = document.createElement('label');
        label.className = 'tx-edit-field';
        const span = document.createElement('span');
        span.textContent = 'Your value';
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
        const xInput = addNumberField('X', 'x', Number(op.params.x ?? 0));
        const yInput = addNumberField('Y', 'y', Number(op.params.y ?? 0));
        return {
          box,
          collect: () => ({ x: Number(xInput.value), y: Number(yInput.value) }),
        };
      }
      case 'resize': {
        const sizeInput = addNumberField('Size', 'size', Number(op.params.size ?? 40));
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
    box: HTMLElement,
    cs: ChangeSet,
    op: ChangeSetOperation,
    interactive: boolean,
  ): void {
    const row = document.createElement('div');
    const skipped = !op.included;
    row.className = skipped ? 'tx-op tx-op-skipped' : 'tx-op';
    const heading = headingOf(op.kind, op.params, op.label);

    if (interactive) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = op.included;
      check.setAttribute('aria-label', `Include ${heading}`);
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
      mark.className = 'op-mark';
      mark.textContent = op.status === 'applied' ? '✓' : op.status === 'failed' ? '✗' : '—';
      row.appendChild(mark);
    }

    const body = document.createElement('span');
    body.className = 'op-body';
    const head = document.createElement('span');
    head.className = 'op-heading';
    head.textContent = heading;
    const value = document.createElement('span');
    value.className = 'op-value';
    const newValue = valueOf(op.kind, op.params);
    const oldValue = valueOf(op.kind, op.originalParams);
    if (skipped) {
      // What WOULD have changed, dimmed — the badge explains it is not applied.
      value.classList.add('op-value-dim');
      value.textContent = newValue ? `Would have applied: ${newValue}` : '';
    } else if (op.amended && oldValue && newValue && oldValue !== newValue) {
      value.textContent = `${oldValue} → ${newValue}`;
    } else {
      value.textContent = newValue;
    }
    body.append(head, value);
    row.appendChild(body);

    if (op.amended) {
      const badge = document.createElement('span');
      badge.className = 'op-amended-badge';
      badge.textContent = 'Edited by you';
      row.appendChild(badge);
    }
    if (skipped) {
      const badge = document.createElement('span');
      badge.className = 'op-skipped-badge';
      badge.textContent = 'Skipped';
      row.appendChild(badge);
    }

    if (interactive) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'op-edit-btn';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${heading}`);
      edit.addEventListener('click', () => {
        const st = states.get(cs.id);
        if (st) {
          st.editingOpId = st.editingOpId === op.id ? null : op.id;
          renderCard(cs);
        }
      });
      row.appendChild(edit);
    }
    box.appendChild(row);

    const st = states.get(cs.id);
    if (interactive && st?.editingOpId === op.id) {
      const form = buildEditForm(op);
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'tx-save';
      save.textContent = 'Save';
      save.addEventListener('click', () => {
        if (!guard) return;
        try {
          guard.amendOperation(cs.id, op.id, form.collect());
          // Successful Save closes the edit form: the "Edited by you" badge on
          // the re-rendered row IS the confirmation.
          const cur = states.get(cs.id);
          if (cur) {
            cur.editingOpId = null;
            renderCard(cs);
          }
        } catch (e) {
          // FIX D: inline error, the form stays open, nothing is mutated.
          let err = form.box.querySelector<HTMLElement>('.tx-error');
          if (!err) {
            err = document.createElement('div');
            err.className = 'tx-error';
            form.box.appendChild(err);
          }
          renderErrorInto(err, e);
        }
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'tx-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        const cur = states.get(cs.id);
        if (cur) {
          cur.editingOpId = null;
          renderCard(cs);
        }
      });
      actions.append(save, cancel);
      form.box.appendChild(actions);
      box.appendChild(form.box);
    }
  }

  function renderCard(cs: ChangeSet): void {
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
    const title = document.createElement('h3');
    title.className = 'tx-heading';
    title.textContent = `“${cs.intent}”`;
    const chip = document.createElement('span');
    chip.className = `tx-chip tx-${cs.status}`;
    chip.textContent = STATUS_LABELS[cs.status] ?? cs.status;
    head.append(title, chip);

    const sub = document.createElement('p');
    sub.className = 'tx-subtitle';
    const n = cs.operations.length;
    sub.textContent = `${n} proposed change${n === 1 ? '' : 's'}`;

    const terminal = TERMINAL_STATUSES.includes(cs.status);
    const receipt = receipts.get(cs.id);

    if (terminal && receipt) {
      // The receipt IS the card body for decided ChangeSets with one.
      card.append(head, sub);
      renderReceipt(card, receipt);
      return;
    }

    const opsBox = document.createElement('div');
    opsBox.className = 'tx-ops';
    for (const op of cs.operations) renderOpRow(card, opsBox, cs, op, !terminal);

    card.append(head, sub, opsBox);

    if (!terminal) {
      // A preview that could not be computed must SAY so. Rendering the card
      // without its diff and without this note is the silent-empty-preview
      // failure the guard now refuses to produce: the human would read an
      // unremarkable card and commit on a simulation that never ran.
      const previewError = states.get(cs.id)?.preview?.error;
      if (previewError) {
        const note = document.createElement('div');
        note.className = 'tx-error';
        note.textContent =
          'Preview unavailable — this proposal could not be simulated, so nothing shown here is what would actually apply.';
        const detail = document.createElement('span');
        detail.className = 'err-code';
        detail.textContent = previewError;
        note.appendChild(detail);
        card.appendChild(note);
      }
      if (cs.isStale) {
        const staleNote = document.createElement('div');
        staleNote.className = 'tx-stale-note';
        staleNote.textContent =
          'The poster changed while this proposal was open — ask the agent for a fresh proposal.';
        card.appendChild(staleNote);
      }
      const includedCount = cs.operations.filter((o) => o.included).length;
      const actions = document.createElement('div');
      actions.className = 'tx-actions';
      const commit = document.createElement('button');
      commit.type = 'button';
      commit.className = 'tx-commit';
      commit.textContent = `Commit ${includedCount} change${includedCount === 1 ? '' : 's'}`;
      // "Commit 0 changes" must never be reachable: the empty subset is a
      // human-UI error (guard keeps EMPTY_CHANGESET for the programmatic path).
      // Re-evaluated on every toggle/amend re-render of the card.
      commit.disabled = includedCount === 0;
      commit.addEventListener('click', () => {
        if (!guard) return;
        // FIX D: errors (e.g. EMPTY_CHANGESET, INVALID_OPERATION from the
        // commit-time chain re-validation) render inline; never to console.
        // humanizeError maps EXECUTION_FAILED to the partially-updated copy and
        // ROLLBACK_FAILED to its own — no per-tx branch needed.
        guard.commitChangeSet(cs.id).catch((e: unknown) => showError(card, e));
      });
      const decline = document.createElement('button');
      decline.type = 'button';
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
    } else {
      const note = document.createElement('p');
      note.className = 'tx-terminal-note';
      if (cs.status === 'stale') note.textContent = 'This proposal expired — nothing was applied.';
      else if (cs.status === 'declined') note.textContent = 'Declined — nothing was applied.';
      else if (cs.status === 'cancelled') note.textContent = 'Cancelled — nothing was applied.';
      else if (cs.status === 'failed')
        // EXECUTION_FAILED is state-uncertain by construction and
        // ROLLBACK_FAILED is worse — an apply was attempted and did not
        // complete, the poster may be partially updated, always.
        note.textContent =
          "A change couldn't be fully applied — the poster may be in a partially updated state.";
      card.appendChild(note);
    }
  }

  const adapter: UIAdapter & { bind(g: RediniGuard): void; renderHistoryError(e: unknown): void } = {
    onChangesetUpdated(cs, preview) {
      const prev = states.get(cs.id);
      states.set(cs.id, {
        cs: structuredClone(cs),
        preview,
        editingOpId:
          cs.status === 'proposed' || cs.status === 'reviewing' ? (prev?.editingOpId ?? null) : null,
      });
      renderCard(cs);
      updateHistoryButtons();
    },
    onReceipt(receipt) {
      receipts.set(receipt.transactionId, structuredClone(receipt));
      logDev(
        `receipt ${receipt.transactionId.slice(0, 8)} — applied ${receipt.applied.length}/${receipt.intended.length}` +
          (receipt.amended.length ? `, ${receipt.amended.length} amended` : '') +
          (receipt.skippedByHuman.length ? `, ${receipt.skippedByHuman.length} skipped` : ''),
      );
      updateHistoryButtons();
    },
    onUndo(ev: UndoEvent) {
      logDev(`undo ${ev.transactionId.slice(0, 8)} (${ev.tool})`);
      updateHistoryButtons();
    },
    onRedo(ev: RedoEvent) {
      logDev(`redo ${ev.transactionId.slice(0, 8)} (${ev.tool})`);
      updateHistoryButtons();
    },
    onAudit(entry: AuditEntry) {
      logDev(
        `${entry.kind} ${entry.tool} ${entry.txId}` +
          (entry.detail && Object.keys(entry.detail).length > 0 ? ` ${JSON.stringify(entry.detail)}` : ''),
      );
      logActivity(humanizeAudit(entry));
    },
    bind(g: RediniGuard) {
      guard = g;
      undoBtn?.addEventListener('click', () => {
        if (!guard || undoBusy || !guard.canUndo()) return;
        undoBusy = true;
        updateHistoryButtons();
        guard
          .undo()
          .then(() => clearHistoryError())
          .catch((e: unknown) => showHistoryError(e))
          .finally(() => {
            undoBusy = false;
            updateHistoryButtons();
          });
      });
      redoBtn?.addEventListener('click', () => {
        if (!guard || redoBusy || !guard.canRedo()) return;
        redoBusy = true;
        updateHistoryButtons();
        guard
          .redo()
          .then(() => clearHistoryError())
          .catch((e: unknown) => showHistoryError(e))
          .finally(() => {
            redoBusy = false;
            updateHistoryButtons();
          });
      });
      updateHistoryButtons();
    },
    renderHistoryError(e: unknown): void {
      showHistoryError(e);
    },
  };

  return adapter;
}