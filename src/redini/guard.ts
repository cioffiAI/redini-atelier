import { RediniError } from './errors';
import { deepEqual } from './utils';
import { CHANGESET_LIMITS, DECIDED_CHANGESET_STATUSES } from './types';
import type {
  AgentOutcome,
  AuditEntry,
  ChangeSet,
  ChangeSetOperation,
  ChangeSetReceipt,
  ChangeSetToolDefinition,
  HistoryEntry,
  ModelContextLike,
  Operation,
  PreviewInfo,
  ReceiptRow,
  RedoEvent,
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
  actor: 'agent' | 'human';
  ops: InternalOp[];
  stateVersion: number;
  mutationIndex: number;
  status: ChangeSet['status'];
  proposedAt: number;
  committedAt: number | null;
  resolve: ((outcome: AgentOutcome) => void) | null;
  settled: boolean;
  /** Set ONLY on failure paths where the world MAY be partially changed. */
  stateUncertain?: boolean;
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
  /** Editor-style history: top of the undo stack = most recently committed entry. */
  private readonly undoStack: HistoryEntry[] = [];
  /** Top of the redo stack = the most recently undone entry (cleared by every new commit). */
  private readonly redoStack: HistoryEntry[] = [];
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
    opts?: { actor?: 'agent' | 'human' },
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
    if (intent.length > CHANGESET_LIMITS.maxIntentLength) {
      throw new RediniError(
        'INVALID_OPERATION',
        `intent too long (max ${CHANGESET_LIMITS.maxIntentLength} characters)`,
      );
    }
    const rawOps = Array.isArray(input?.operations) ? (input.operations as Array<Record<string, unknown>>) : [];
    if (rawOps.length === 0) {
      throw new RediniError('INVALID_OPERATION', 'the ChangeSet has no operations');
    }
    if (rawOps.length > CHANGESET_LIMITS.maxOps) {
      throw new RediniError('INVALID_OPERATION', `too many operations (max ${CHANGESET_LIMITS.maxOps})`);
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
      // Validator context: the raw ops validated so far (current params, in
      // order) so a sequential rule (e.g. derived logo bounds) is evaluated
      // against the same derived state the op will actually apply on.
      const validationError = def.validate?.(
        { kind, params },
        rawOps.slice(0, i).map((r) => ({
          kind: String(r?.kind ?? ''),
          params: (r?.params as Record<string, unknown> | undefined) ?? {},
        })),
      );
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
      actor: opts?.actor ?? 'agent',
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
    if (DECIDED_CHANGESET_STATUSES.includes(cs.status)) {
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
    if (DECIDED_CHANGESET_STATUSES.includes(cs.status)) {
      throw new RediniError('ALREADY_DECIDED', `ChangeSet ${csId} is already ${cs.status}`);
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new RediniError('INVALID_AMENDMENT', `operation ${opId}: amendment params must be a plain object`);
    }
    // Amendment validation runs against the SAME derived state the commit will
    // apply on: the prior INCLUDED ops (their CURRENT params, in order).
    const priorIncluded = cs.ops
      .slice(0, cs.ops.findIndex((o) => o.id === opId))
      .filter((o) => o.included)
      .map((o) => ({ kind: o.kind, params: structuredClone(o.params) }));
    const validationError = this.changesetDef(cs.tool).validate?.(
      { kind: op.kind, params },
      priorIncluded,
    );
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
    if (DECIDED_CHANGESET_STATUSES.includes(cs.status)) {
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

    // COMMIT-TIME CHAIN RE-VALIDATION: dispatch-time validation is early
    // feedback; the included chain is re-validated at commit because skip/amend
    // can change the derived state after per-op validation — skipping an
    // earlier resize means a later move commits against the LIVE state, and an
    // amended parameter can push a later op off-canvas. Each included op is
    // validated against the accumulated PRIOR INCLUDED context (current params,
    // in order) — exactly the derived state the commit will apply on. Any
    // failure throws INVALID_OPERATION BEFORE any mutation, WITHOUT settling
    // the agent promise and WITHOUT changing the changeset status (stays
    // 'reviewing' — the human can amend/skip and retry, same semantics as
    // EMPTY_CHANGESET).
    const revalidatedPrior: Array<{ kind: string; params: Record<string, unknown> }> = [];
    for (const op of included) {
      const validationError = def.validate?.(
        { kind: op.kind, params: structuredClone(op.params) },
        revalidatedPrior.map((p) => ({ kind: p.kind, params: structuredClone(p.params) })),
      );
      if (validationError) {
        throw new RediniError('INVALID_OPERATION', `operation ${op.id}: ${validationError}`);
      }
      revalidatedPrior.push({ kind: op.kind, params: structuredClone(op.params) });
    }

    const stateVersionBefore = cs.stateVersion;
    const inverses: Operation[] = [];
    const appliedIds: string[] = [];
    // MELD: counts EVERY attempted runtime.apply in the main apply loop — an
    // apply that throws may have mutated the world WITHOUT returning an
    // inverse (we do NOT assume failure-atomic applies), so even a failed
    // first op makes the bump conservative.
    let applyAttempts = 0;
    try {
      for (const op of included) {
        applyAttempts += 1;
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
      // each success. If every compensation succeeds the rollback completed
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
      // An apply was attempted and did not complete — it may have mutated
      // state without returning an inverse, so the resulting application state
      // is UNCERTAIN even when the completed prefix compensates cleanly.
      // Redini never claims "nothing happened" without certainty: every
      // failed commit is state-uncertain by construction.
      cs.stateUncertain = true;
      cs.status = 'failed';
      this.emitUpdate(cs);
      // MELD: a failed commit conservatively invalidates pending proposals.
      // An apply that throws may have mutated state without returning an
      // inverse (we do NOT assume failure-atomic applies) — any ATTEMPTED
      // apply bumps the counter, so a pending proposal can never stay reported
      // fresh over a changed world even for runtimes WITHOUT getStateVersion.
      // appliedIds stays the rollback-reporting source of truth above.
      if (applyAttempts > 0) this.mutationCounter += 1;
      this.sweepPendingPreviews();
      if (rollbackFailure) {
        this.audit('failed', cs, {
          error: message,
          rolledBack: compensated.length,
          rollbackFailed: true,
          failedCompensation: rollbackFailure.id,
          stateUncertain: true,
        });
        this.settle(cs, {
          status: 'execute_failed',
          changeSetId: cs.id,
          appliedCount: 0,
          amendedCount: 0,
          skippedCount: 0,
          undoAvailable: false,
          stateUncertain: true,
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
      this.audit('failed', cs, {
        error: message,
        rolledBack: compensated.length,
        stateUncertain: cs.stateUncertain === true,
      });
      this.settle(cs, {
        status: 'execute_failed',
        changeSetId: cs.id,
        appliedCount: 0,
        amendedCount: 0,
        skippedCount: 0,
        undoAvailable: false,
        stateUncertain: true,
        error: { code: 'EXECUTION_FAILED', message },
      });
      throw new RediniError('EXECUTION_FAILED', message, e);
    }

    this.mutationCounter += 1;
    cs.status = 'committed';
    cs.committedAt = this.now();
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
      proposedAt: cs.proposedAt,
      committedAt: cs.committedAt,
    };
    // Editor-style history entry. forwardOperations are the NEGOTIATED set —
    // current (amended) params + labels — because that is EXACTLY what redo
    // must replay to re-commit this subset. inverseOperations restore the
    // previous state in reverse application order. A new commit invalidates
    // the undone future: the redo stack is cleared.
    const entry: HistoryEntry = {
      id: this.nextId(),
      changeSetId: cs.id,
      tool: cs.tool,
      forwardOperations: included.map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        originalLabel: o.originalLabel,
        params: structuredClone(o.params),
      })),
      inverseOperations: [...inverses].reverse(),
      // The HISTORY copy is a structuredClone of the receipt: the emitted
      // receipt stays the app-facing object — mutating it can never corrupt
      // the stored entry (receipts remain behaviorally immutable artifacts).
      receipt: structuredClone(receipt),
      committedAt: cs.committedAt,
    };
    this.undoStack.push(entry);
    this.redoStack.length = 0;

    this.ui.onReceipt(receipt);
    const humanEdited = receipt.amended.length > 0 || receipt.skippedByHuman.length > 0;
    this.audit('committed', cs, {
      humanEdited,
      applied: appliedIds.length,
      amended: receipt.amended.length,
      skipped: receipt.skippedByHuman.length,
    });
    this.emitUpdate(cs);
    this.sweepPendingPreviews();
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
    if (DECIDED_CHANGESET_STATUSES.includes(cs.status)) {
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
   * Deterministic rollback: replays the stored inverse operations, last-applied
   * first (entry.inverseOperations is already in reverse application order).
   * The entry is popped from the undo stack only AFTER every inverse succeeded;
   * on failure it STAYS on the stack, the ChangeSet becomes 'undo_failed' and a
   * truthful 'undo_failed' audit is emitted. Retrying a failed undo is safe:
   * the inverses are set-semantics (idempotent) — Atelier's are (each inverse
   * sets a concrete value) — so a partial replay converges on retry.
   */
  async undo(): Promise<UndoEvent> {
    if (this.undoStack.length === 0) {
      throw new RediniError('NOTHING_TO_UNDO', 'nothing to undo');
    }
    const entry = this.undoStack[this.undoStack.length - 1];
    const def = this.changesetDef(entry.tool);
    // Truthful progress: `done` tracks the inverses ACTUALLY replayed before a
    // failure — the audit must never report the whole list or its total length.
    const done: string[] = [];
    try {
      for (const inv of entry.inverseOperations) {
        def.runtime.apply(inv);
        done.push(inv.id);
      }
    } catch (e) {
      const failingInverseId = entry.inverseOperations[done.length]?.id ?? 'unknown';
      const cause = e instanceof Error ? e.message : String(e);
      const detail = {
        attempted: [...done, failingInverseId],
        remaining: entry.inverseOperations.slice(done.length + 1).map((inv) => inv.id),
        cause,
      };
      const cs = this.changeSets.get(entry.changeSetId);
      if (cs) cs.status = 'undo_failed';
      this.ui.onAudit({
        kind: 'undo_failed',
        txId: entry.changeSetId,
        tool: entry.tool,
        at: this.now(),
        detail,
      });
      if (cs) this.emitUpdate(cs);
      // MELD: same conservative invalidation as the commit — the catch is
      // reachable only after >=1 inverse apply attempt, and a throwing apply
      // may have mutated the world without returning (no inverse captured).
      this.mutationCounter += 1;
      // MAJOR 3: the partial replay already moved the state (version bump) —
      // pending ChangeSets must be re-emitted NOW so their isStale flag and
      // previews refresh instead of lying until the next event.
      this.sweepPendingPreviews();
      throw new RediniError(
        'UNDO_FAILED',
        `undo of ${entry.changeSetId} failed after ${done.length} successful compensations`,
        e,
        detail,
      );
    }
    // Only now — after every inverse succeeded — does the entry move to the
    // redo stack (top = most recently undone).
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.mutationCounter += 1;

    const cs = this.changeSets.get(entry.changeSetId);
    if (cs && (cs.status === 'committed' || cs.status === 'undo_failed')) cs.status = 'undone';
    const ev: UndoEvent = {
      type: 'undo',
      transactionId: entry.changeSetId,
      tool: entry.tool,
      undoneAt: this.now(),
    };
    this.ui.onUndo(ev);
    this.audit('undone', cs, { operations: entry.inverseOperations.length });
    if (cs) this.emitUpdate(cs);
    this.sweepPendingPreviews();
    return ev;
  }

  /**
   * Deterministic redo: re-applies the entry's stored FORWARD operations — the
   * negotiated (amended) set — in application order, capturing FRESH inverses
   * so the entry moving back to the undo stack undoes this redo exactly. On
   * failure the entry STAYS on the redo stack, the ChangeSet stays 'undone'
   * and a truthful 'redo_failed' audit is emitted. Retrying a failed redo is
   * safe: the forward operations are set-semantics (each writes a concrete
   * value), so a partial replay converges on retry.
   */
  async redo(): Promise<RedoEvent> {
    if (this.redoStack.length === 0) {
      throw new RediniError('NOTHING_TO_REDO', 'nothing to redo');
    }
    const entry = this.redoStack[this.redoStack.length - 1];
    const def = this.changesetDef(entry.tool);
    const freshInverses: Operation[] = [];
    const done: string[] = [];
    try {
      for (const op of entry.forwardOperations) {
        // Clone discipline mirrored from commit: a mutating app runtime can
        // never corrupt the params stored in the history entry.
        const inverse = def.runtime.apply({
          id: op.id,
          kind: op.kind,
          label: op.label,
          originalLabel: op.originalLabel,
          params: structuredClone(op.params),
        });
        freshInverses.push(inverse);
        done.push(op.id);
      }
    } catch (e) {
      const failingOpId = entry.forwardOperations[done.length]?.id ?? 'unknown';
      const cause = e instanceof Error ? e.message : String(e);
      const detail = {
        attempted: [...done, failingOpId],
        remaining: entry.forwardOperations.slice(done.length + 1).map((op) => op.id),
        cause,
      };
      const cs = this.changeSets.get(entry.changeSetId);
      this.ui.onAudit({
        kind: 'redo_failed',
        txId: entry.changeSetId,
        tool: entry.tool,
        at: this.now(),
        detail,
      });
      if (cs) this.emitUpdate(cs);
      // MELD: same conservative invalidation as the commit — the catch is
      // reachable only after >=1 forward apply attempt, and a throwing apply
      // may have mutated the world without returning an inverse.
      this.mutationCounter += 1;
      // MAJOR 3: same stale sweep as the undo failure path — the partial
      // replay moved the state, pending ChangeSets must refresh immediately.
      this.sweepPendingPreviews();
      throw new RediniError(
        'REDO_FAILED',
        `redo of ${entry.changeSetId} failed after ${done.length} successful replays`,
        e,
        detail,
      );
    }
    this.redoStack.pop();
    entry.inverseOperations = freshInverses.reverse();
    this.undoStack.push(entry);
    this.mutationCounter += 1;

    const cs = this.changeSets.get(entry.changeSetId);
    // Symmetric with undo(): a redo also repairs a changeSet left 'undo_failed'.
    if (cs && (cs.status === 'undone' || cs.status === 'undo_failed')) cs.status = 'committed';
    // The receipt is an immutable historical artifact: it is NOT rewritten or
    // re-emitted for the redo — undo+redo leave the negotiation record intact.
    const ev: RedoEvent = {
      type: 'redo',
      transactionId: entry.changeSetId,
      tool: entry.tool,
      redoneAt: this.now(),
    };
    this.ui.onRedo(ev);
    this.audit('redone', cs, { applied: done.length });
    if (cs) this.emitUpdate(cs);
    this.sweepPendingPreviews();
    return ev;
  }

  /** Editor-style availability: a non-empty undo stack. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Read-only view of the whole editor history: undone entries first (oldest
   * commit at index 0), redo entries after them. Every entry is a
   * structuredClone DTO — forwardOperations, inverseOperations and the receipt
   * are isolated from the stored history, so consumers can never corrupt the
   * stacks. Safe for audit/debug surfaces.
   */
  /**
   * Read-only DTO view of the history (undo + redo). Each entry is deep-cloned
   * so consumers cannot corrupt replay data. Requires plain-data operations
   * (no functions/class instances inside params — structuredClone semantics).
   */
  getHistory(): readonly HistoryEntry[] {
    return [...this.undoStack, ...this.redoStack].map((entry) => structuredClone(entry));
  }

  /** Editor-style availability: a non-empty redo stack. */
  canRedo(): boolean {
    return this.redoStack.length > 0;
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
      actor: cs.actor,
      operations,
      stateVersion: cs.stateVersion,
      status: cs.status,
      proposedAt: cs.proposedAt,
      committedAt: cs.committedAt,
      isStale: this.csIsStale(cs),
      // Passed through only when set: a clean failure carries NO claim either
      // way, and a successful commit never sets the flag.
      ...(cs.stateUncertain === true ? { stateUncertain: true as const } : {}),
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
    // A decided ChangeSet has no live preview: once the subset is committed /
    // declined / undone / stale, the staged preview is gone entirely.
    const preview = DECIDED_CHANGESET_STATUSES.includes(cs.status) ? null : this.previewFor(cs);
    this.ui.onChangesetUpdated(this.publicCs(cs), preview);
  }

  /**
   * Stale sweep: after every successful commit/undo/redo the pending ChangeSets
   * are re-emitted so their previews recompute against the NEW state and their
   * isStale flag refreshes (enforcement stays lazy, at commit time).
   */
  private sweepPendingPreviews(): void {
    for (const cs of this.changeSets.values()) {
      if (cs.status === 'proposed' || cs.status === 'reviewing') this.emitUpdate(cs);
    }
  }

  /** Same predicate as the commit-time stale check. */
  private csIsStale(cs: InternalChangeSet): boolean {
    let versionChanged = false;
    try {
      const def = this.changesetDef(cs.tool);
      versionChanged = def.getStateVersion !== undefined && def.getStateVersion() !== cs.stateVersion;
    } catch {
      // Tool registration gone (abort teardown): only Redini's own counter can guard.
    }
    return versionChanged || this.mutationCounter !== cs.mutationIndex;
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
      actor: cs?.actor ?? 'agent',
    });
  }
}

export function createGuard(opts: GuardOptions): RediniGuard {
  return new RediniGuard(opts);
}
