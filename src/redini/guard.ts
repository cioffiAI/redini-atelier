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
  RegisterToolRequest,
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
  params: Record<string, unknown>;
  originalParams: Record<string, unknown>;
  included: boolean;
  amended: boolean;
  /** 'intended' until commit; 'applied' | 'failed' after. Skipped is derived from `included`. */
  status: 'intended' | 'applied' | 'failed';
  inverse?: Operation;
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

const DECIDED_STATUSES: ChangeSet['status'][] = ['committed', 'declined', 'undone', 'stale', 'failed'];

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

function toMcpResult(outcome: AgentOutcome): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
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

  attachModelContext(mc: ModelContextLike): void {
    this.mcp = mc;
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
        execute: (input, execOptions) => def.execute(input, execOptions),
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
        execute: async (input, execOptions) =>
          toMcpResult((await this.dispatch(def.name, input, execOptions.signal)) as AgentOutcome),
      },
      options,
    );
  }

  register(def: RegisterToolRequest): void {
    const { mode, ...rest } = def;
    if (mode === 'changeset') this.registerChangeSetTool(rest as ChangeSetToolDefinition);
    else this.registerSafeTool(rest as SafeToolDefinition);
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
    const intent = typeof input.intent === 'string' && input.intent.trim() ? input.intent : '(no intent given)';
    const rawOps = Array.isArray(input.operations) ? (input.operations as Array<Record<string, unknown>>) : [];
    if (rawOps.length === 0) {
      throw new RediniError('INVALID_OPERATION', 'the ChangeSet has no operations');
    }

    const ops: InternalOp[] = rawOps.map((raw, i) => {
      const kind = String(raw?.kind ?? '');
      const params = ((raw?.params ?? {}) as Record<string, unknown>) ?? {};
      if (!def.kinds.includes(kind)) {
        throw new RediniError('INVALID_OPERATION', `operation ${i + 1}: unknown kind "${kind}"`);
      }
      const validationError = def.validate?.({ kind, params });
      if (validationError) {
        throw new RediniError('INVALID_OPERATION', `operation ${i + 1}: ${validationError}`);
      }
      return {
        id: `op-${i + 1}`,
        kind,
        params: structuredClone(params),
        originalParams: structuredClone(params),
        label: def.describeOperation?.({ kind, params }) ?? `${kind} ${JSON.stringify(params)}`,
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
        cs.status = 'declined';
        this.audit('cancelled', cs, { reason: 'agent_aborted' });
        this.settle(cs, { status: 'cancelled', txId: cs.id });
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

  /** Amend a single operation's parameters before commit. The original is preserved for the receipt. */
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
    op.params = structuredClone(params);
    op.amended = !deepEqual(params, op.originalParams);
    cs.status = 'reviewing';
    this.audit('reviewing', cs, { op: opId, amended: op.amended });
    this.emitUpdate(cs);
    return { changeset: this.publicCs(cs), preview: this.previewFor(cs) };
  }

  /**
   * Human decision: atomic commit of the included subset.
   * Each applied operation yields its inverse; if any apply throws, the already
   * applied ones are rolled back through their inverses (all-or-nothing).
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
        txId: cs.id,
        message: 'State changed since this ChangeSet was proposed. Re-propose with fresh data.',
      });
      throw new RediniError('STALE_TRANSACTION', `ChangeSet ${csId} was proposed on a previous state`);
    }

    const included = cs.ops.filter((o) => o.included);
    if (included.length === 0) {
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
          params: structuredClone(op.params),
        });
        inverses.push(inverse);
        op.status = 'applied';
        op.inverse = inverse;
        appliedIds.push(op.id);
      }
    } catch (e) {
      // Atomic: undo what was already applied, in reverse order.
      for (const inv of [...inverses].reverse()) {
        try {
          def.runtime.apply(inv);
        } catch {
          /* best effort rollback */
        }
      }
      for (const op of included) op.status = 'failed';
      const message = e instanceof Error ? e.message : String(e);
      cs.status = 'failed';
      this.audit('failed', cs, { error: message, rolledBack: inverses.length });
      this.emitUpdate(cs);
      this.settle(cs, { status: 'execute_failed', txId: cs.id, error: message });
      throw e instanceof Error ? e : new Error(message);
    }

    this.mutationCounter += 1;
    cs.status = 'committed';
    cs.committedAt = this.now();
    const undoToken = this.nextId();
    const stateVersionAfter = def.getStateVersion?.() ?? this.mutationCounter;

    const receipt: ChangeSetReceipt = {
      transactionId: cs.id,
      tool: cs.tool,
      intent: cs.intent,
      intended: cs.ops.map((o) => this.row(o, o.originalParams)),
      amended: cs.ops
        .filter((o) => o.amended && o.status === 'applied')
        .map((o) => this.row(o, o.params)),
      skippedByHuman: cs.ops.filter((o) => !o.included).map((o) => this.row(o, o.params)),
      applied: appliedIds,
      stateVersionBefore,
      stateVersionAfter,
      undoToken,
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
      txId: cs.id,
      intent: cs.intent,
      appliedCount: appliedIds.length,
      amendedCount: receipt.amended.length,
      skippedCount: receipt.skippedByHuman.length,
      receipt,
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
    this.settle(cs, { status: 'declined_by_user', txId: cs.id, reason });
    return this.publicCs(cs);
  }

  /** Deterministic rollback: replays the stored inverse operations, last-applied first. */
  async undo(undoToken: string): Promise<UndoEvent> {
    const record = this.undoRecords.get(undoToken);
    if (!record) throw new RediniError('UNKNOWN_TOKEN', `no undo record for token "${undoToken}"`);
    if (record.consumed) throw new RediniError('ALREADY_UNDONE', `token ${undoToken} was already used`);
    record.consumed = true;

    const def = this.changesetDef(record.tool);
    for (const inv of record.inverses) {
      def.runtime.apply(inv);
    }
    this.mutationCounter += 1;

    const cs = this.changeSets.get(record.csId);
    if (cs && cs.status === 'committed') cs.status = 'undone';
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

  private row(op: InternalOp, params: Record<string, unknown>): ReceiptRow {
    return { id: op.id, label: op.label, params: structuredClone(params) };
  }

  private publicCs(cs: InternalChangeSet): ChangeSet {
    const operations: ChangeSetOperation[] = cs.ops.map((o) => ({
      id: o.id,
      kind: o.kind,
      label: o.label,
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
      .map((o) => ({ kind: o.kind, params: o.params }));
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
