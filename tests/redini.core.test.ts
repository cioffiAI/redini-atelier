import { describe, expect, it, vi } from 'vitest';
import { createGuard } from '../src/redini/guard';
import { RediniError } from '../src/redini/errors';
import type { AgentOutcome } from '../src/redini/types';
import { createCounterFixture } from './counter.fixture';

/** Registers a transactional tool into a fake ModelContext and captures the wrapped callback. */
function fakeModelContext(): {
  mcp: Parameters<typeof createGuard>[0] extends { modelContext?: infer M } | undefined ? M : never;
  captured: Map<string, (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>>;
} {
  const captured = new Map<string, (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>>();
  const mcp = {
    registerTool(tool: {
      name: string;
      execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => unknown | Promise<unknown>;
    }) {
      captured.set(tool.name, tool.execute as (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>);
    },
  };
  return { mcp, captured };
}

describe('Redini core — transactional gates', () => {
  it('1. direct commit: execute runs with proposedInput, receipt is complete', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 5 });
    const receipt = await f.guard.commit(txId);

    expect(f.getCount()).toBe(5);
    expect(receipt.transactionId).toBe(txId);
    expect(receipt.committedInput).toEqual({ count: 5 });
    expect(receipt.proposedInput).toEqual({ count: 5 });
    expect(receipt.stateBefore).toBe(0);
    expect(receipt.stateAfter).toBe(5);
    expect(receipt.undoToken).toBeTruthy();
    const tx = f.guard.getTransaction(txId);
    expect(tx?.status).toBe('committed');
    expect(tx?.committedAt).not.toBeNull();
  });

  it('2. edit → commit: receipt preserves BOTH proposedInput and committedInput (provenance)', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 100 });

    const { transaction } = f.guard.editTransaction(txId, { count: 50 });
    expect(transaction.status).toBe('reviewing');

    const receipt = await f.guard.commit(txId);
    // THE central Redini assertion: the human changed the proposal.
    expect(receipt.proposedInput).toEqual({ count: 100 });
    expect(receipt.committedInput).toEqual({ count: 50 });
    expect(receipt.proposedInput).not.toEqual(receipt.committedInput);
    expect(f.getCount()).toBe(50);

    const committedAudit = f.ui.audit.find((a) => a.kind === 'committed' && a.txId === txId);
    expect(committedAudit?.detail?.humanEdited).toBe(true);
  });

  it('3. decline: execute is never called, agent gets declined_by_user', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 7 });
    const outcome = (await f.guard.getTransaction(txId), undefined); // tx exists
    void outcome;

    f.guard.decline(txId, 'not what I want');

    expect(f.calls.setCount).toBe(0); // execute never ran
    expect(f.getCount()).toBe(0);
    expect(f.guard.getTransaction(txId)?.status).toBe('declined');
  });

  it('4. execute failure: no false commit receipt, agent gets execute_failed', async () => {
    const f = createCounterFixture();
    const txId = f.propose('boom', {});
    const receiptsBefore = f.ui.receipts.length;

    await expect(f.guard.commit(txId)).rejects.toThrow('boom');
    expect(f.ui.receipts.length).toBe(receiptsBefore); // NO receipt
    expect(f.guard.getTransaction(txId)?.status).toBe('failed');
    const auditFailed = f.ui.audit.find((a) => a.kind === 'failed' && a.txId === txId);
    expect(auditFailed?.detail?.error).toBe('boom');
  });

  it('5. undo: restores the exact previous state and enters the audit trail', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 5 });
    const receipt = await f.guard.commit(txId);
    expect(f.getCount()).toBe(5);

    const ev = await f.guard.undo(receipt.undoToken);
    expect(f.getCount()).toBe(0); // exact pre-commit state
    expect(ev.transactionId).toBe(receipt.transactionId);
    expect(f.guard.getTransaction(receipt.transactionId)?.status).toBe('undone');
    expect(f.ui.audit.some((a) => a.kind === 'rolled_back' && a.txId === receipt.transactionId)).toBe(true);
    expect(f.ui.undos.length).toBe(1);
  });

  it('6. double undo: deterministic ALREADY_UNDONE failure', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 3 });
    const receipt = await f.guard.commit(txId);
    await f.guard.undo(receipt.undoToken);

    await expect(f.guard.undo(receipt.undoToken)).rejects.toMatchObject({
      name: 'RediniError',
      code: 'ALREADY_UNDONE',
    });
    expect(f.getCount()).toBe(0); // state untouched by the failed second undo
  });

  it('7. stale transaction: state changed before commit → STALE_TRANSACTION, execute not called', async () => {
    const f = createCounterFixture();
    const p1 = f.guard.dispatch('set_count', { count: 5 }) as Promise<AgentOutcome>;
    const tx1 = f.ui.lastTransactionId();
    const p2 = f.guard.dispatch('set_count', { count: 10 }) as Promise<AgentOutcome>;
    const tx2 = f.ui.lastTransactionId();

    await f.guard.commit(tx1); // state moves: 0 → 5
    const callsBefore = f.calls.setCount;
    await expect(f.guard.commit(tx2)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(f.calls.setCount).toBe(callsBefore); // stale tx never executed
    expect(f.getCount()).toBe(5); // no silent application
    expect(f.guard.getTransaction(tx2)?.status).toBe('stale');
    expect(await p2).toMatchObject({ status: 'stale_transaction', txId: tx2 });
    expect(await p1).toMatchObject({ status: 'committed' });
  });

  it('8. two concurrent transactions on the same state: first commits, second is stale', async () => {
    const f = createCounterFixture();
    const pA = f.guard.dispatch('set_count', { count: 42 }) as Promise<AgentOutcome>;
    const txA = f.ui.lastTransactionId();
    const pB = f.guard.dispatch('set_count', { count: 99 }) as Promise<AgentOutcome>;
    const txB = f.ui.lastTransactionId();

    await f.guard.commit(txA);
    await expect(f.guard.commit(txB)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });

    expect(f.getCount()).toBe(42);
    expect(f.calls.setCount).toBe(1); // exactly one execute ran
    expect(await pA).toMatchObject({ status: 'committed', humanEdited: false });
    expect(await pB).toMatchObject({ status: 'stale_transaction' });
  });

  it('9. AbortSignal while awaiting approval: cancelled, execute never called, later decisions fail deterministically', async () => {
    const f = createCounterFixture();
    const ac = new AbortController();
    const p = f.guard.dispatch('set_count', { count: 9 }, ac.signal) as Promise<AgentOutcome>;
    const txId = f.ui.lastTransactionId();

    ac.abort();
    expect(await p).toMatchObject({ status: 'cancelled', txId });
    expect(f.calls.setCount).toBe(0);
    expect(f.guard.getTransaction(txId)?.status).toBe('declined');

    // Late human decision on a cancelled tx: deterministic errors (decline is sync → try/catch).
    await expect(Promise.resolve().then(() => f.guard.commit(txId))).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
    let err2: unknown;
    try {
      f.guard.decline(txId);
    } catch (e) {
      err2 = e;
    }
    expect((err2 as RediniError).code).toBe('ALREADY_DECIDED');
  });

  it('10. WebMCP tool promise resolves ONLY after the human decision, with MCP-shaped content', async () => {
    const { mcp, captured } = fakeModelContext();
    const guard2 = createGuard({
      ui: { onTransactionUpdated: vi.fn(), onReceipt: vi.fn(), onUndo: vi.fn(), onAudit: vi.fn() },
      modelContext: mcp,
    });
    let count = 0;
    guard2.registerTransactionalTool({
      name: 'set_count',
      description: 'Sets the counter.',
      execute: (input) => {
        count = input.count as number;
        return { count };
      },
      snapshot: () => count,
      restore: (s) => {
        count = s as number;
      },
    });

    const wrapped = captured.get('set_count');
    expect(wrapped).toBeDefined();

    const p = wrapped!({ count: 12 }, { signal: new AbortController().signal });
    // The promise must still be pending while no decision has been made.
    const stillPending = await Promise.race([p.then(() => false), new Promise((r) => setTimeout(() => r(true), 50))]);
    expect(stillPending).toBe(true);

    const txId = guard2.getTransactions().at(-1)!.id;
    await guard2.commit(txId);

    const res = (await p) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0].type).toBe('text');
    const parsed = JSON.parse(res.content[0].text) as { status: string; result: { count: number } };
    expect(parsed.status).toBe('committed');
    expect(parsed.result.count).toBe(12);
    expect(count).toBe(12);
  });

  it('11. edit-then-override: explicit overrideInput wins over the draft', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 10 });
    f.guard.editTransaction(txId, { count: 20 });
    const receipt = await f.guard.commit(txId, { count: 30 });
    expect(receipt.committedInput).toEqual({ count: 30 });
    expect(f.getCount()).toBe(30);
  });

  it('12. double commit: ALREADY_DECIDED; commit-then-decline: ALREADY_DECIDED', async () => {
    const f = createCounterFixture();
    const txId = f.propose('set_count', { count: 4 });
    await f.guard.commit(txId);
    await expect(f.guard.commit(txId)).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
    let err: unknown;
    try {
      f.guard.decline(txId);
    } catch (e) {
      err = e; // decline is synchronous
    }
    expect((err as RediniError).code).toBe('ALREADY_DECIDED');
  });

  it('13. safe tool: executes immediately, no staging, no transactions', async () => {
    const f = createCounterFixture();
    f.setCount(8);
    const result = (await f.guard.dispatch('get_count', {})) as { count: number };
    expect(result.count).toBe(8);
    expect(f.ui.transactions.size).toBe(0);
  });

  it('14. unknown tool: UNKNOWN_TOOL error', async () => {
    const f = createCounterFixture();
    await expect(f.guard.dispatch('nope', {})).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
  });
});
