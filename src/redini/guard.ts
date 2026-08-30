import { RediniError } from './errors';
import { deepEqual } from './utils';
import type {
  AgentOutcome,
  AuditEntry,
  ChangeSet,
  ChangeSetOperation,
  ChangeSetReceipt,
  ChangeSetToolDefinition,
  ModelContextLike,
  Operation,
  PreviewInfo,
  ReceiptRow,
  SafeToolDefinition,
  UIAdapter,
  UndoEvent,
} from './types';

type AnyDefinition = SafeToolDefinition | ChangeSetToolDefinition;

interface Registration {
  kind: 'safe' | 'changeset';
  def: AnyDefinition;
}

interface InternalOp {
  id: string;
  kind: string;
  label: string;
  originalLabel: string;
  params: Record<string, unknown>;
  originalParams: Record<string, unknown>;
  included: boolean;
  amended: boolean;
  /** 'intended' until commit; 'applied' | 'failed' after. Skipped is derived from `included`. */
  status: 'intended' | 'applied' | 'failed';
}

interface InternalChangeSet {
  id: string;
  tool: string;
  intent: string;
  ops: InternalOp[];
  stateVersion: number;
  mutationIndex: number;
  status: ChangeSet['status'];
  proposedAt: number;
  committedAt: number | null;
  resolve: ((outcome: AgentOutcome) => void) | null;
  settled: boolean;
}

interface UndoRecord {
  csId: string;
  tool: string;
  /** Inverses in REVERSE application order: undo replays them 1:1. */
  inverses: Operation[];
  consumed: boolean;
}

export interface GuardOptions {
  ui: UIAdapter & {
    /** Optional hook called by createGuard to hand the guard to the adapter. */
    bind?: (guard: RediniGuard) => void;
  };
  modelContext?: ModelContextLike | null;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable id factory for deterministic tests. */
  idFactory?: () => string;
}

const DECIDED_STATUSES: ChangeSet['status'][] = [
  'committed',
  'declined',
  'cancelled',
  'undone',
  'stale',
  'failed',
  'undo_failed',
];

function defaultInputSchema(kinds: string[]): object {
  return {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'One sentence: what this ChangeSet is trying to achieve for the user.',
      },
      operations: {
        type: 'array',
        minItems: 1,
        description:
          'The individual operations to propose. The human can preview the result, amend parameters, skip operations and atomically commit the subset.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: kinds },
            params: {
              type: 'object',
              additionalProperties: true,
              description: 'Parameters for this operation.',
            },
          },
          required: ['kind', 'params'],
        },
      },
    },
    required: ['intent', 'operations'],
  };
}

function toMcpResult(outcome: AgentOutcome): AgentOutcome {
  // FIX I: direct structured serialization — the execute callback returns this
  // object as-is; no `{content:[{type:'text',...}]}` envelope.
  return outcome;
}

function executeFailedResult(changeSetId: string | null, e: unknown): AgentOutcome {
  return {
    status: 'execute_failed',
    changeSetId,
    appliedCount: 0,
    amendedCount: 0,
    skippedCount: 0,
    undoAvailable: false,
    error: {
      code: e instanceof RediniError ? e.code : 'EXECUTION_FAILED',
      message: e instanceof Error ? e.message : String(e),
    },
  };
}

export class RediniGuard {
  private readonly registrations = new Map<string, Registration>();
  private readonly changeSets = new Map<string, InternalChangeSet>();
  private readonly undoRecords = new Map<string, UndoRecord>();
  /** Redini-owned change counter: the stale guard works even if the app never bumps its version. */
  private mutationCounter = 0;
  private readonly ui: UIAdapter;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private mcp: ModelContextLike | null;

  constructor(opts: GuardOptions) {
    this.ui = opts.ui;
    this.now = opts.now ?? Date.now;
    this.nextId =
      opts.idFactory ??
      (() => globalThis.crypto?.randomUUID?.() ?? `tx-${Math.random().toString(36).slice(2, 10)}`);
    this.mcp = opts.modelContext ?? null;
    opts.ui.bind?.(this);
  }

  registerSafeTool(def: SafeToolDefinition, options?: { signal?: AbortSignal }): void {
    this.registrations.set(def.name, { kind: 'safe', def });
    this.mcp?.registerTool(
      {
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations ?? { readOnlyHint: true },
        execute: (input, execOptions) =>
          // The browser may invoke execute(input) with a single argument —
          // normalize the context so the tool definition always sees {signal}.
          def.execute(input, execOptions ?? { signal: new AbortController().signal }),
      },
      options,
    );
    // Keep the in-page registry consistent with the WebMCP registry on abort,
    // so dynamic unregistration behaves the same with and without a model context.
    options?.signal?.addEventListener(
      'abort',
      () => {
        this.registrations.delete(def.name);
      },
      { once: true },
    );
  }

  registerChangeSetTool(def: ChangeSetToolDefinition, options?: { signal?: AbortSignal }): void {
    this.registrations.set(def.name, { kind: 'changeset', def });
    this.mcp?.registerTool(
      {
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema ?? defaultInputSchema(def.kinds),
        annotations: { readOnlyHint: false },
        execute: async (input, execOptions) => {
          // FIX I: the changeset execute callback NEVER rejects. Pre-staging
          // validation failures resolve with status 'execute_failed' instead of
          // throwing; mid-commit failures settle the inner promise with the
          // same structured error. EMPTY_CHANGESET never reaches this path — it
          // is a human-UI error and the agent promise stays pending.
          try {
            return toMcpResult(
              (await this.dispatch(def.name, input, execOptions?.signal)) as AgentOutcome,
            );
          } catch (e) {
            return executeFailedResult(null, e);
          }
        },
      },
      options,
    );
  }

  /**
   * The single entry point for agent-originated calls.
   * - safe tools: execute immediately, return raw result.
   * - changeset tools: validate the operations, stage the ChangeSet, wait for
   *   the human decision, resolve with a structured AgentOutcome.
   */
  async dispatch(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    const reg = this.registrations.get(toolName);
    if (!reg) throw new RediniError('UNKNOWN_TOOL', `no tool registered as "${toolName}"`);

    if (reg.kind === 'safe') {
      return await (reg.def as SafeToolDefinition).execute(input, { signal });
    }

    const def = reg.def as ChangeSetToolDefinition;
    // Schema parity: the inputSchema marks `intent` as REQUIRED — no default.
    const intent = typeof input?.intent === 'string' && input.intent.trim() ? input.intent : null;
    if (!intent) {
      throw new RediniError('INVALID_OPERATION', 'the ChangeSet needs an "intent" string');
    }
    const rawOps = Array.isArray(input?.operations) ? (input.operations as Array<Record<string, unknown>>) : [];
    if (rawOps.length === 0) {
      throw new RediniError('INVALID_OPERATION', 'the ChangeSet has no operations');
    }

    const ops: InternalOp[] = rawOps.map((raw, i) => {
      // Schema parity: each operation object is additionalProperties:false —
      // reject keys other than kind/params instead of silently ignoring them.
      const extraKey = Object.keys(raw ?? {}).find((k) => k !== 'kind' && k !== 'params');
      if (extraKey !== undefined) {
        throw new RediniError('INVALID_OPERATION', `operation ${i + 1}: unknown key "${extraKey}"`);
      }
      const kind = String(raw?.kind ?? '');
      const params = ((raw?.params ?? {}) as Record<string, unknown>) ?? {};
      if (!def.kinds.includes(kind)) {
        throw new RediniError('INVALID_OPERATION', `operation ${i + 1}: unknown kind "${kind}"`);
      }
      const validationError = def.validate?.({ kind, params });
      if (validationError) {
        throw new RediniError('INVALID_OPERATION', `operation ${i + 1}: ${validationError}`);
      }
      const label = def.describeOperation?.({ kind, params }) ?? `${kind} ${JSON.stringify(params)}`;
      return {
        id: `op-${i + 1}`,
        kind,
        params: structuredClone(params),
        originalParams: structuredClone(params),
        label,
        originalLabel: label, // the agent's original description — immutable, shown in receipts
        included: true,
        amended: false,
        status: 'intended' as const,
      };
    });

    const cs: InternalChangeSet = {
      id: this.nextId(),
      tool: def.name,
      intent,
      ops,
      stateVersion: def.getStateVersion?.() ?? 0,
      mutationIndex: this.mutationCounter,
      status: 'proposed',
      proposedAt: this.now(),
      committedAt: null,
      resolve: null,
      settled: false,
    };
    this.changeSets.set(cs.id, cs);
    this.ui.onChangesetUpdated(this.publicCs(cs), this.previewFor(cs));
    this.audit('proposed', cs);

    return await new Promise<AgentOutcome>((resolve) => {
      cs.resolve = resolve;
      const onAbort = (): void => {
        if (cs.settled || !(cs.status === 'proposed' || cs.status === 'reviewing')) return;
        // FIX D: the human (or host) aborted the invocation — the ChangeSet is
        // visibly 'cancelled', UI subscribers are notified, the agent promise
        // settles exactly once.
        cs.status = 'cancelled';
        this.audit('cancelled', cs, { reason: 'agent_aborted' });
        this.emitUpdate(cs);
        this.settle(cs, {
          status: 'cancelled',
          changeSetId: cs.id,
          appliedCount: 0,
          amendedCount: 0,
          skippedCount: 0,
          undoAvailable: false,
        });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Cherry-pick: include or exclude a single operation. Excluded ops are never applied. */
  toggleOperation(csId: string, opId: string, include: boolean): ChangeSet {
    const cs = this.requireCs(csId);
    const op = this.requireOp(cs, opId);
    if (DECIDED_STATUSES.includes(cs.status)) {
      throw new RediniError('ALREADY_DECIDED', `ChangeSet ${csId} is already ${cs.status}`);
    }
    op.included = include;
    cs.status = 'reviewing';
    this.audit('reviewing', cs, { op: opId, toggled: include ? 'included' : 'skipped' });
    this.emitUpdate(cs);
    return this.publicCs(cs);
  }

  /**
   * FIX A+B: VALIDATED amendment with recomputed description.
   * - rejects non-plain-object params with INVALID_AMENDMENT;
   * - runs the registered tool's `validate` on {kind, params}; a string error
   *   throws INVALID_AMENDMENT and leaves the operation UNMUTATED;
   * - on success: params = structuredClone(params) and label is RECOMPUTED via
   *   describeOperation with the NEW params;
   * - originalParams (and originalLabel) stay immutable forever.
   */
  amendOperation(
    csId: string,
    opId: string,
    params: Record<string, unknown>,
  ): { changeset: ChangeSet; preview: PreviewInfo | null } {
    const cs = this.requireCs(csId);
    const op = this.requireOp(cs, opId);
    if (DECIDED_STATUSES.includes(cs.status)) {
      throw new RediniError('ALREADY_DECIDED', `ChangeSet ${csId} is already ${cs.status}`);
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new RediniError('INVALID_AMENDMENT', `operation ${opId}: amendment params must be a plain object`);
    }
    const validationError = this.changesetDef(cs.tool).validate?.({ kind: op.kind, params });
    if (validationError) {
      throw new RediniError('INVALID_AMENDMENT', `operation ${opId}: ${validationError}`);
    }
    op.params = structuredClone(params);
    op.amended = !deepEqual(params, op.originalParams);
    op.label =
      this.changesetDef(cs.tool).describeOperation?.({ kind: op.kind, params }) ??
      `${op.kind} ${JSON.stringify(params)}`;
    cs.status = 'reviewing';
    this.audit('reviewing', cs, { op: opId, amended: op.amended });
    this.emitUpdate(cs);
    return { changeset: this.publicCs(cs), preview: this.previewFor(cs) };
  }

  /**
   * Human decision: atomic commit of the included subset.
   * Each applied operation yields its inverse; if any apply throws, the already
   * applied ones are rolled back through their inverses (all-or-nothing).
   *
   * FIX F: rollback reporting is TRUTHFUL — `rolledBack` counts actual
   * compensation successes, and a failed compensation surfaces ROLLBACK_FAILED
   * with structured detail.
   *
   * FIX I: on failure the agent promise settles with status 'execute_failed'
   * and the typed error code (EXECUTION_FAILED or ROLLBACK_FAILED); the typed
   * RediniError is rethrown for the human UI caller. EMPTY_CHANGESET is the
   * ONLY committing error that does NOT settle the agent promise — it is a
   * human-UI error and the ChangeSet stays 'reviewing'.
   */
  async commitChangeSet(csId: string): Promise<ChangeSetReceipt> {
    const cs = this.requireCs(csId);
    const def = this.changesetDef(cs.tool);
    if (DECIDED_STATUSES.includes(cs.status)) {
      throw new RediniError('ALREADY_DECIDED', `ChangeSet ${csId} is already ${cs.status}`);
    }

    const appVersionChanged =
      def.getStateVersion !== undefined && def.getStateVersion() !== cs.stateVersion;
    if (appVersionChanged || this.mutationCounter !== cs.mutationIndex) {
      cs.status = 'stale';
      this.audit('stale', cs);
      this.emitUpdate(cs);
      this.settle(cs, {
        status: 'stale_transaction',
        changeSetId: cs.id,
        appliedCount: 0,
        amendedCount: 0,
        skippedCount: 0,
        undoAvailable: false,
        error: { code: 'STALE_TRANSACTION', message: 'State changed since this ChangeSet was proposed. Re-propose with fresh data.' },
      });
      throw new RediniError('STALE_TRANSACTION', `ChangeSet ${csId} was proposed on a previous state`);
    }

    const included = cs.ops.filter((o) => o.included);
    if (included.length === 0) {
      // Human-UI error only: the agent promise stays pending, the ChangeSet
      // stays 'reviewing' so the human can re-include operations.
      throw new RediniError('EMPTY_CHANGESET', 'every operation was skipped: nothing to commit');
    }

    const stateVersionBefore = cs.stateVersion;
    const inverses: Operation[] = [];
    const appliedIds: string[] = [];
    try {
      for (const op of included) {
        const inverse = def.runtime.apply({
          id: op.id,
          kind: op.kind,
          label: op.label,
          originalLabel: op.originalLabel,
          params: structuredClone(op.params),
        });
        inverses.push(inverse);
        op.status = 'applied';
        appliedIds.push(op.id);
      }
    } catch (e) {
      // Atomic: compensate what was already applied, in reverse order, tracking
      // each success. If every compensation succeeds the commit failed cleanly
      // (EXECUTION_FAILED). If a compensation itself fails we surface
      // ROLLBACK_FAILED with the exact partial state — no false rolledBack count.
      const compensated: string[] = [];
      let rollbackFailure: { id: string; cause: unknown } | null = null;
      for (const inv of [...inverses].reverse()) {
        try {
          def.runtime.apply(inv);
          compensated.push(inv.id);
        } catch (cause) {
          rollbackFailure = { id: inv.id, cause };
          break;
        }
      }
      for (const op of included) op.status = 'failed';
      const message = e instanceof Error ? e.message : String(e);
      cs.status = 'failed';
      this.emitUpdate(cs);
      if (rollbackFailure) {
        this.audit('failed', cs, {
          error: message,
          rolledBack: compensated.length,
          rollbackFailed: true,
          failedCompensation: rollbackFailure.id,
        });
        this.settle(cs, {
          status: 'execute_failed',
          changeSetId: cs.id,
          appliedCount: 0,
          amendedCount: 0,
          skippedCount: 0,
          undoAvailable: false,
          error: { code: 'ROLLBACK_FAILED', message },
        });
        throw new RediniError(
          'ROLLBACK_FAILED',
          `ChangeSet ${csId} failed and its rollback is incomplete`,
          rollbackFailure.cause,
          {
            appliedOperations: appliedIds,
            compensatedOperations: compensated,
            failedCompensation: rollbackFailure.id,
          },
        );
      }
      this.audit('failed', cs, { error: message, rolledBack: compensated.length });
      this.settle(cs, {
        status: 'execute_failed',
        changeSetId: cs.id,
        appliedCount: 0,
        amendedCount: 0,
        skippedCount: 0,
        undoAvailable: false,
        error: { code: 'EXECUTION_FAILED', message },
      });
      throw new RediniError('EXECUTION_FAILED', message, e);
    }

    this.mutationCounter += 1;
    cs.status = 'committed';
    cs.committedAt = this.now();
    const undoToken = this.nextId();
    const stateVersionAfter = def.getStateVersion?.() ?? this.mutationCounter;

    const originalRow = (o: InternalOp): ReceiptRow => ({
      id: o.id,
      kind: o.kind,
      label: o.originalLabel,
      params: structuredClone(o.originalParams),
    });
    const currentRow = (o: InternalOp): ReceiptRow => ({
      id: o.id,
      kind: o.kind,
      label: o.label,
      params: structuredClone(o.params),
    });
    const amendedRow = (o: InternalOp): ReceiptRow => ({
      id: o.id,
      kind: o.kind,
      label: o.label,
      originalLabel: o.originalLabel,
      params: structuredClone(o.params),
      originalParams: structuredClone(o.originalParams),
    });

    const receipt: ChangeSetReceipt = {
      transactionId: cs.id,
      changeSetId: cs.id,
      tool: cs.tool,
      intent: cs.intent,
      intended: cs.ops.map((o) => originalRow(o)),
      amended: cs.ops.filter((o) => o.amended && o.status === 'applied').map((o) => amendedRow(o)),
      skippedByHuman: cs.ops.filter((o) => !o.included).map((o) => currentRow(o)),
      applied: included.map((o) => currentRow(o)),
      stateVersionBefore,
      stateVersionAfter,
      undoToken,
      proposedAt: cs.proposedAt,
      committedAt: cs.committedAt,
    };
    this.undoRecords.set(undoToken, {
      csId: cs.id,
      tool: cs.tool,
      inverses: [...inverses].reverse(),
      consumed: false,
    });

    this.ui.onReceipt(receipt);
    const humanEdited = receipt.amended.length > 0 || receipt.skippedByHuman.length > 0;
    this.audit('committed', cs, {
      humanEdited,
      applied: appliedIds.length,
      amended: receipt.amended.length,
      skipped: receipt.skippedByHuman.length,
    });
    this.emitUpdate(cs);
    this.settle(cs, {
      status: 'committed',
      changeSetId: cs.id,
      appliedCount: appliedIds.length,
      amendedCount: receipt.amended.length,
      skippedCount: receipt.skippedByHuman.length,
      undoAvailable: true,
    });
    return receipt;
  }

  /** Human decision: reject the whole ChangeSet. Nothing is ever applied. */
  declineChangeSet(csId: string, reason?: string): ChangeSet {
    const cs = this.requireCs(csId);
    if (DECIDED_STATUSES.includes(cs.status)) {
      throw new RediniError('ALREADY_DECIDED', `ChangeSet ${csId} is already ${cs.status}`);
    }
    cs.status = 'declined';
    this.audit('declined', cs, reason ? { reason } : undefined);
    this.emitUpdate(cs);
    this.settle(cs, {
      status: 'declined_by_user',
      changeSetId: cs.id,
      appliedCount: 0,
      amendedCount: 0,
      skippedCount: 0,
      undoAvailable: false,
    });
    return this.publicCs(cs);
  }

  /**
   * Deterministic rollback: replays the stored inverse operations, last-applied first.
   *
   * FIX E — undo token lifecycle: the token is marked consumed ONLY after ALL
   * inverses succeeded. Inverses are expected to be set-semantics (idempotent) —
   * Atelier's are (each inverse sets a concrete value), so retrying a failed undo
   * with the same token is safe. On failure the token stays usable, the ChangeSet
   * becomes 'undo_failed', an 'undo_failed' audit entry with structured detail is
   * emitted, and a typed UNDO_FAILED RediniError is thrown.
   */
  async undo(undoToken: string): Promise<UndoEvent> {
    const record = this.undoRecords.get(undoToken);
    if (!record) throw new RediniError('UNKNOWN_TOKEN', `no undo record for token "${undoToken}"`);
    if (record.consumed) throw new RediniError('ALREADY_UNDONE', `token ${undoToken} was already used`);

    const def = this.changesetDef(record.tool);
    // Truthful progress: `done` tracks the inverses ACTUALLY replayed before the
    // failure — the audit must never report the whole list or its total length.
    const done: string[] = [];
    try {
      for (const inv of record.inverses) {
        def.runtime.apply(inv);
        done.push(inv.id);
      }
    } catch (e) {
      const failingInverseId = record.inverses[done.length]?.id ?? 'unknown';
      const cause = e instanceof Error ? e.message : String(e);
      const detail = {
        undoToken,
        attempted: [...done, failingInverseId],
        remaining: record.inverses.slice(done.length + 1).map((inv) => inv.id),
        cause,
      };
      const cs = this.changeSets.get(record.csId);
      if (cs) cs.status = 'undo_failed';
      this.ui.onAudit({
        kind: 'undo_failed',
        txId: record.csId,
        tool: record.tool,
        at: this.now(),
        detail,
      });
      if (cs) this.emitUpdate(cs);
      throw new RediniError(
        'UNDO_FAILED',
        `undo of ${record.csId} failed after ${done.length} successful compensations`,
        e,
        detail,
      );
    }
    // Only now — after every inverse succeeded — is the token consumed.
    record.consumed = true;
    this.mutationCounter += 1;

    const cs = this.changeSets.get(record.csId);
    if (cs && (cs.status === 'committed' || cs.status === 'undo_failed')) cs.status = 'undone';
    const ev: UndoEvent = {
      type: 'undo',
      transactionId: record.csId,
      tool: record.tool,
      undoToken,
      undoneAt: this.now(),
    };
    this.ui.onUndo(ev);
    this.audit('rolled_back', cs, { undoToken, operations: record.inverses.length });
    if (cs) this.emitUpdate(cs);
    return ev;
  }

  getChangeSet(csId: string): ChangeSet | undefined {
    const cs = this.changeSets.get(csId);
    return cs ? this.publicCs(cs) : undefined;
  }

  getChangeSets(): ChangeSet[] {
    return [...this.changeSets.values()].map((cs) => this.publicCs(cs));
  }

  // ---------- internals ----------

  private requireCs(csId: string): InternalChangeSet {
    const cs = this.changeSets.get(csId);
    if (!cs) throw new RediniError('UNKNOWN_CHANGESET', `no ChangeSet "${csId}"`);
    return cs;
  }

  private requireOp(cs: InternalChangeSet, opId: string): InternalOp {
    const op = cs.ops.find((o) => o.id === opId);
    if (!op) throw new RediniError('UNKNOWN_CHANGESET', `no operation "${opId}" in ${cs.id}`);
    return op;
  }

  private changesetDef(tool: string): ChangeSetToolDefinition {
    const reg = this.registrations.get(tool);
    if (!reg || reg.kind !== 'changeset') {
      throw new RediniError('UNKNOWN_TOOL', `no changeset tool registered as "${tool}"`);
    }
    return reg.def as ChangeSetToolDefinition;
  }

  private publicCs(cs: InternalChangeSet): ChangeSet {
    const operations: ChangeSetOperation[] = cs.ops.map((o) => ({
      id: o.id,
      kind: o.kind,
      label: o.label,
      originalLabel: o.originalLabel,
      params: structuredClone(o.params),
      originalParams: structuredClone(o.originalParams),
      included: o.included,
      amended: o.amended,
      status:
        o.status === 'applied' || o.status === 'failed'
          ? o.status
          : !o.included
            ? 'skipped'
            : o.amended
              ? 'amended'
              : 'intended',
    }));
    return {
      id: cs.id,
      tool: cs.tool,
      intent: cs.intent,
      operations,
      stateVersion: cs.stateVersion,
      status: cs.status,
      proposedAt: cs.proposedAt,
      committedAt: cs.committedAt,
    };
  }

  private previewFor(cs: InternalChangeSet): PreviewInfo {
    const def = this.changesetDef(cs.tool);
    const included = cs.ops
      .filter((o) => o.included)
      .map((o) => ({ kind: o.kind, params: structuredClone(o.params) }));
    const simulated = def.runtime.simulate(included);
    const amendedCount = cs.ops.filter((o) => o.amended && o.included).length;
    const skippedCount = cs.ops.filter((o) => !o.included).length;
    const parts: string[] = [`${included.length}/${cs.ops.length} operation(s) will apply`];
    if (amendedCount > 0) parts.push(`${amendedCount} amended by you`);
    if (skippedCount > 0) parts.push(`${skippedCount} skipped by you`);
    return {
      summary: parts.join(' · '),
      diff: { appliedPreview: simulated },
    };
  }

  private emitUpdate(cs: InternalChangeSet): void {
    this.ui.onChangesetUpdated(this.publicCs(cs), this.previewFor(cs));
  }

  private settle(cs: InternalChangeSet, outcome: AgentOutcome): void {
    if (cs.settled) return;
    cs.settled = true;
    cs.resolve?.(outcome);
  }

  private audit(kind: AuditEntry['kind'], cs: InternalChangeSet | undefined, detail?: Record<string, unknown>): void {
    this.ui.onAudit({
      kind,
      txId: cs?.id ?? 'unknown',
      tool: cs?.tool ?? 'unknown',
      at: this.now(),
      detail,
    });
  }
}

export function createGuard(opts: GuardOptions): RediniGuard {
  return new RediniGuard(opts);
}
