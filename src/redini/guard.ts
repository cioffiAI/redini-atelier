import { RediniError } from './errors';
import { deepEqual } from './utils';
import type {
  AgentOutcome,
  AuditEntry,
  ModelContextLike,
  PreviewInfo,
  Receipt,
  RegisterToolRequest,
  SafeToolDefinition,
  Transaction,
  TransactionalToolDefinition,
  UIAdapter,
  UndoEvent,
} from './types';

type AnyDefinition = SafeToolDefinition | TransactionalToolDefinition;

interface Registration {
  kind: 'safe' | 'transaction';
  def: AnyDefinition;
}

interface InternalTx {
  id: string;
  tool: string;
  proposedInput: Record<string, unknown>;
  draftInput: Record<string, unknown> | null;
  committedInput: Record<string, unknown> | null;
  stateVersion: number;
  mutationIndex: number;
  status: Transaction['status'];
  proposedAt: number;
  committedAt: number | null;
  resolve: ((outcome: AgentOutcome) => void) | null;
  settled: boolean;
}

interface SnapshotRecord {
  txId: string;
  tool: string;
  stateBefore: unknown;
  restore: (stateBefore: unknown) => void | Promise<void>;
  consumed: boolean;
}

export interface GuardOptions {
  ui: UIAdapter & { /** Optional hook called by createGuard to receive the guard instance. */ bind?: (guard: RediniGuard) => void };
  modelContext?: ModelContextLike | null;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable id factory for deterministic tests. */
  idFactory?: () => string;
}

const DECIDED_STATUSES: Transaction['status'][] = ['committed', 'declined', 'undone', 'stale', 'failed'];

function toMcpResult(outcome: AgentOutcome): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
}

export class RediniGuard {
  private readonly registrations = new Map<string, Registration>();
  private readonly txs = new Map<string, InternalTx>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
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
      (() =>
        globalThis.crypto?.randomUUID?.() ??
        `tx-${Math.random().toString(36).slice(2, 10)}`);
    this.mcp = opts.modelContext ?? null;
    opts.ui.bind?.(this);
  }

  /** Attach (or re-attach) a model context. Registered tools are NOT re-registered automatically. */
  attachModelContext(mc: ModelContextLike): void {
    this.mcp = mc;
  }

  registerSafeTool(def: SafeToolDefinition): void {
    this.registrations.set(def.name, { kind: 'safe', def });
    this.mcp?.registerTool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations ?? { readOnlyHint: true },
      execute: (input, options) => def.execute(input, options),
    });
  }

  registerTransactionalTool(def: TransactionalToolDefinition): void {
    this.registrations.set(def.name, { kind: 'transaction', def });
    this.mcp?.registerTool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
      execute: async (input, options) =>
      toMcpResult((await this.dispatch(def.name, input, options.signal)) as AgentOutcome),
    });
  }

  register(def: RegisterToolRequest): void {
    const { mode, ...rest } = def;
    if (mode === 'transaction') this.registerTransactionalTool(rest as TransactionalToolDefinition);
    else this.registerSafeTool(rest as SafeToolDefinition);
  }

  /**
   * The single entry point for agent-originated calls.
   * - safe tools: execute immediately, return raw result.
   * - transaction tools: create a staged transaction, wait for the human decision,
   *   resolve with a structured AgentOutcome (never throws for domain reasons).
   */
  async dispatch(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    const reg = this.registrations.get(toolName);
    if (!reg) throw new RediniError('UNKNOWN_TOOL', `no tool registered as "${toolName}"`);

    if (reg.kind === 'safe') {
      return await reg.def.execute(input, { signal });
    }

    const def = reg.def as TransactionalToolDefinition;
    const tx: InternalTx = {
      id: this.nextId(),
      tool: def.name,
      proposedInput: structuredClone(input),
      draftInput: null,
      committedInput: null,
      stateVersion: def.getStateVersion?.() ?? 0,
      mutationIndex: this.mutationCounter,
      status: 'proposed',
      proposedAt: this.now(),
      committedAt: null,
      resolve: null,
      settled: false,
    };
    this.txs.set(tx.id, tx);
    const preview = def.preview?.(tx.proposedInput) ?? null;
    this.ui.onTransactionUpdated(this.publicTx(tx), preview);
    this.audit('proposed', tx);

    return await new Promise<AgentOutcome>((resolve) => {
      tx.resolve = resolve;
      const onAbort = (): void => {
        if (tx.settled || !(tx.status === 'proposed' || tx.status === 'reviewing')) return;
        tx.status = 'declined';
        this.audit('cancelled', tx, { reason: 'agent_aborted' });
        this.settle(tx, { status: 'cancelled', txId: tx.id });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Human decision: commit (optionally overriding/drafting the input). Throws on stale/double-commit. */
  async commit(txId: string, overrideInput?: Record<string, unknown>): Promise<Receipt> {
    const tx = this.requireTx(txId);
    const def = this.transactionalDef(tx.tool);
    if (DECIDED_STATUSES.includes(tx.status)) {
      throw new RediniError('ALREADY_DECIDED', `transaction ${txId} is already ${tx.status}`);
    }

    const appVersionChanged =
      def.getStateVersion !== undefined && def.getStateVersion() !== tx.stateVersion;
    if (appVersionChanged || this.mutationCounter !== tx.mutationIndex) {
      tx.status = 'stale';
      this.audit('stale', tx);
      this.emitUpdate(tx);
      this.settle(tx, {
        status: 'stale_transaction',
        txId: tx.id,
        message: 'State changed since this transaction was proposed. Re-propose with fresh data.',
      });
      throw new RediniError('STALE_TRANSACTION', `transaction ${txId} was proposed on a previous state`);
    }

    const committedInput = structuredClone(overrideInput ?? tx.draftInput ?? tx.proposedInput);
    const stateBefore = def.snapshot();
    const undoToken = this.nextId();
    tx.committedInput = committedInput;
    tx.status = 'committed';
    tx.committedAt = this.now();

    let result: unknown;
    try {
      result = await def.execute(committedInput, { signal: new AbortController().signal });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tx.status = 'failed';
      this.audit('failed', tx, { error: message });
      this.emitUpdate(tx);
      this.settle(tx, { status: 'execute_failed', txId: tx.id, error: message });
      throw e instanceof Error ? e : new Error(message);
    }

    this.mutationCounter += 1;
    const receipt: Receipt = {
      transactionId: tx.id,
      tool: tx.tool,
      proposedInput: tx.proposedInput,
      committedInput,
      stateBefore,
      stateAfter: def.snapshot(),
      undoToken,
      committedAt: tx.committedAt,
    };
    this.snapshots.set(undoToken, {
      txId: tx.id,
      tool: tx.tool,
      stateBefore,
      restore: def.restore,
      consumed: false,
    });
    this.ui.onReceipt(receipt);
    const humanEdited = !deepEqual(tx.proposedInput, committedInput);
    this.audit('committed', tx, { humanEdited });
    this.emitUpdate(tx);
    this.settle(tx, { status: 'committed', txId: tx.id, result, humanEdited });
    return receipt;
  }

  /** Human decision: reject the proposal. `execute` is never called. */
  decline(txId: string, reason?: string): Transaction {
    const tx = this.requireTx(txId);
    if (DECIDED_STATUSES.includes(tx.status)) {
      throw new RediniError('ALREADY_DECIDED', `transaction ${txId} is already ${tx.status}`);
    }
    tx.status = 'declined';
    this.audit('declined', tx, reason ? { reason } : undefined);
    this.emitUpdate(tx);
    this.settle(tx, { status: 'declined_by_user', txId: tx.id, reason });
    return this.publicTx(tx);
  }

  /**
   * Human edits the proposed input before committing. The draft recomputes the preview;
   * a subsequent commit() uses the draft unless an explicit override is passed.
   */
  editTransaction(
    txId: string,
    newInput: Record<string, unknown>,
  ): { transaction: Transaction; preview: PreviewInfo | null } {
    const tx = this.requireTx(txId);
    if (DECIDED_STATUSES.includes(tx.status)) {
      throw new RediniError('ALREADY_DECIDED', `transaction ${txId} is already ${tx.status}`);
    }
    tx.draftInput = structuredClone(newInput);
    tx.status = 'reviewing';
    const def = this.transactionalDef(tx.tool);
    const preview = def.preview?.(tx.draftInput) ?? null;
    this.ui.onTransactionUpdated(this.publicTx(tx), preview);
    this.audit('reviewing', tx, { humanEditedDraft: !deepEqual(tx.proposedInput, tx.draftInput) });
    return { transaction: this.publicTx(tx), preview };
  }

  /** Verifiable rollback: restores the exact pre-commit state. Tokens are single-use. */
  async undo(undoToken: string): Promise<UndoEvent> {
    const snap = this.snapshots.get(undoToken);
    if (!snap) throw new RediniError('UNKNOWN_TOKEN', `no snapshot for undo token "${undoToken}"`);
    if (snap.consumed) throw new RediniError('ALREADY_UNDONE', `token ${undoToken} was already used`);
    snap.consumed = true;

    await snap.restore(snap.stateBefore);
    this.mutationCounter += 1;
    const tx = this.txs.get(snap.txId);
    if (tx && tx.status === 'committed') tx.status = 'undone';
    const ev: UndoEvent = {
      type: 'undo',
      transactionId: snap.txId,
      tool: snap.tool,
      undoToken,
      undoneAt: this.now(),
    };
    this.ui.onUndo(ev);
    this.audit('rolled_back', tx, { undoToken });
    if (tx) this.emitUpdate(tx);
    return ev;
  }

  getTransaction(txId: string): Transaction | undefined {
    const tx = this.txs.get(txId);
    return tx ? this.publicTx(tx) : undefined;
  }

  getTransactions(): Transaction[] {
    return [...this.txs.values()].map((tx) => this.publicTx(tx));
  }

  private requireTx(txId: string): InternalTx {
    const tx = this.txs.get(txId);
    if (!tx) throw new RediniError('UNKNOWN_TRANSACTION', `no transaction "${txId}"`);
    return tx;
  }

  private transactionalDef(tool: string): TransactionalToolDefinition {
    const reg = this.registrations.get(tool);
    if (!reg || reg.kind !== 'transaction') {
      throw new RediniError('UNKNOWN_TOOL', `no transactional tool registered as "${tool}"`);
    }
    return reg.def as TransactionalToolDefinition;
  }

  private settle(tx: InternalTx, outcome: AgentOutcome): void {
    if (tx.settled) return;
    tx.settled = true;
    tx.resolve?.(outcome);
  }

  private publicTx(tx: InternalTx): Transaction {
    return {
      id: tx.id,
      tool: tx.tool,
      proposedInput: tx.proposedInput,
      committedInput: tx.committedInput ? structuredClone(tx.committedInput) : null,
      stateVersion: tx.stateVersion,
      status: tx.status,
      proposedAt: tx.proposedAt,
      committedAt: tx.committedAt,
    };
  }

  /** Re-emit a transaction card after any status change, with the preview recomputed on the effective input. */
  private emitUpdate(tx: InternalTx): void {
    const reg = this.registrations.get(tx.tool);
    const def = reg && reg.kind === 'transaction' ? (reg.def as TransactionalToolDefinition) : undefined;
    const effectiveInput = tx.committedInput ?? tx.draftInput ?? tx.proposedInput;
    const preview = def?.preview?.(effectiveInput) ?? null;
    this.ui.onTransactionUpdated(this.publicTx(tx), preview);
  }

  private audit(kind: AuditEntry['kind'], tx: InternalTx | undefined, detail?: Record<string, unknown>): void {
    this.ui.onAudit({
      kind,
      txId: tx?.id ?? 'unknown',
      tool: tx?.tool ?? 'unknown',
      at: this.now(),
      detail,
    });
  }
}

export function createGuard(opts: GuardOptions): RediniGuard {
  return new RediniGuard(opts);
}
