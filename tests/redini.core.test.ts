import { describe, expect, it, vi } from 'vitest';
import { createGuard } from '../src/redini/guard';
import { RediniError } from '../src/redini/errors';
import type { AgentOutcome, ModelContextLike, OperationRuntime } from '../src/redini/types';
import { InMemoryUI } from '../src/redini/ui/in-memory';

/**
 * Deterministic canvas-like fixture for the ChangeSet gates.
 * State: { texts: {title, subtitle}, fills: {background, text}, font, box: {x, y, size}, version }
 * Operation kinds: setText / setFill / setFont / move / resize / boom (fails on apply).
 */
function createCanvasFixture() {
  const ui = new InMemoryUI();
  let idCounter = 0;
  let tick = 1000;
  const guard = createGuard({
    ui,
    idFactory: () => `id-${++idCounter}`,
    now: () => ++tick,
  });

  const state = {
    texts: { title: 'Hello', subtitle: 'Sub' },
    fills: { background: '#ffffff', text: '#000000' },
    font: 'Georgia, serif',
    box: { x: 10, y: 10, size: 60 },
    version: 0,
  };
  const applyCalls = { count: 0 };

  const runtime: OperationRuntime = {
    apply(op) {
      applyCalls.count += 1;
      const p = op.params;
      switch (op.kind) {
        case 'setText': {
          const field = String(p.field) as 'title' | 'subtitle';
          const prev = state.texts[field];
          state.texts[field] = String(p.value);
          state.version += 1;
          return { id: op.id, kind: 'setText', label: op.label, params: { field, value: prev } };
        }
        case 'setFill': {
          const target = String(p.target) as 'background' | 'text';
          const prev = state.fills[target];
          state.fills[target] = String(p.value);
          state.version += 1;
          return { id: op.id, kind: 'setFill', label: op.label, params: { target, value: prev } };
        }
        case 'setFont': {
          const prev = state.font;
          state.font = String(p.value);
          state.version += 1;
          return { id: op.id, kind: 'setFont', label: op.label, params: { value: prev } };
        }
        case 'move': {
          const prev = { ...state.box };
          state.box = { ...state.box, x: Number(p.x), y: Number(p.y) };
          state.version += 1;
          return { id: op.id, kind: 'move', label: op.label, params: { target: 'box', x: prev.x, y: prev.y } };
        }
        case 'resize': {
          const prev = state.box.size;
          state.box = { ...state.box, size: Number(p.size) };
          state.version += 1;
          return { id: op.id, kind: 'resize', label: op.label, params: { target: 'box', size: prev } };
        }
        case 'boom':
          throw new Error('boom');
        default:
          throw new Error(`unknown kind ${op.kind}`);
      }
    },
    simulate(ops) {
      const s = structuredClone(state);
      for (const op of ops) {
        const p = op.params;
        if (op.kind === 'setText') s.texts[String(p.field) as 'title' | 'subtitle'] = String(p.value);
        if (op.kind === 'setFill') s.fills[String(p.target) as 'background' | 'text'] = String(p.value);
        if (op.kind === 'setFont') s.font = String(p.value);
        if (op.kind === 'move') s.box = { ...s.box, x: Number(p.x), y: Number(p.y) };
        if (op.kind === 'resize') s.box = { ...s.box, size: Number(p.size) };
      }
      return s;
    },
  };

  guard.registerChangeSetTool({
    name: 'design_update',
    description: 'Test ChangeSet tool.',
    kinds: ['setText', 'setFill', 'setFont', 'move', 'resize', 'boom'],
    runtime,
    describeOperation: (op) => {
      const p = op.params;
      if (op.kind === 'setText') return `${p.field} → "${p.value}"`;
      if (op.kind === 'setFill') return `${p.target} fill → ${p.value}`;
      if (op.kind === 'move') return `box → (${p.x}, ${p.y})`;
      return `${op.kind} ${JSON.stringify(p)}`;
    },
    validate: (op) => {
      if (op.kind === 'setFill' && !String(op.params.value).startsWith('#')) {
        return 'fill must be a #rrggbb color';
      }
      if (op.kind === 'setText' && !['title', 'subtitle'].includes(String(op.params.field))) {
        return `unknown text field "${String(op.params.field)}"`;
      }
      return null;
    },
    getStateVersion: () => state.version,
  });

  const propose = (intent: string, operations: Array<{ kind: string; params: Record<string, unknown> }>): string => {
    const p = guard.dispatch('design_update', { intent, operations }) as Promise<AgentOutcome>;
    p.catch(() => {});
    return ui.lastChangeSetId();
  };

  return { guard, ui, state, applyCalls, propose };
}

describe('Redini v3 — ChangeSet gates', () => {
  it('1. direct commit: every intended op applies in order, receipt is complete and coherent', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Make it pop', [
      { kind: 'setText', params: { field: 'title', value: 'AI SUMMIT' } },
      { kind: 'setFill', params: { target: 'background', value: '#FF0055' } },
      { kind: 'move', params: { x: 620, y: 40 } },
    ]);
    const receipt = await f.guard.commitChangeSet(csId);

    expect(receipt.intended).toHaveLength(3);
    expect(receipt.amended).toHaveLength(0);
    expect(receipt.skippedByHuman).toHaveLength(0);
    expect(receipt.applied).toEqual(['op-1', 'op-2', 'op-3']);
    expect(f.state.texts.title).toBe('AI SUMMIT');
    expect(f.state.fills.background).toBe('#FF0055');
    expect(f.state.box.x).toBe(620);
    expect(receipt.stateVersionAfter).toBeGreaterThan(receipt.stateVersionBefore);
    expect(f.guard.getChangeSet(csId)?.status).toBe('committed');
  });

  it('2. amend → commit: receipt preserves INTENDED vs AMENDED (the central provenance assertion)', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Pop the title', [
      { kind: 'setText', params: { field: 'title', value: 'AGENT VERSION' } },
      { kind: 'setFill', params: { target: 'background', value: '#FF0055' } },
    ]);

    // Human amends op-1 (the text), leaves op-2 untouched.
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'HUMAN VERSION' });
    const receipt = await f.guard.commitChangeSet(csId);

    expect(receipt.intended.find((r) => r.id === 'op-1')?.params.value).toBe('AGENT VERSION');
    expect(receipt.amended.find((r) => r.id === 'op-1')?.params.value).toBe('HUMAN VERSION');
    expect(receipt.amended.map((r) => r.id)).toEqual(['op-1']);
    expect(f.state.texts.title).toBe('HUMAN VERSION');
    const audit = f.ui.audit.find((a) => a.kind === 'committed' && a.txId === csId);
    expect(audit?.detail?.humanEdited).toBe(true);
  });

  it('3. cherry-pick: skipped op is never applied, the subset applies atomically', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Restyle', [
      { kind: 'setText', params: { field: 'title', value: 'Kept' } },
      { kind: 'setFill', params: { target: 'background', value: '#FF0055' } }, // will be skipped
      { kind: 'move', params: { x: 300, y: 300 } },
    ]);

    f.guard.toggleOperation(csId, 'op-2', false);
    const receipt = await f.guard.commitChangeSet(csId);

    expect(receipt.skippedByHuman.map((r) => r.id)).toEqual(['op-2']);
    expect(receipt.applied).toEqual(['op-1', 'op-3']);
    expect(f.state.texts.title).toBe('Kept');
    expect(f.state.fills.background).toBe('#ffffff'); // skipped → unchanged
    expect(f.state.box.x).toBe(300);
  });

  it('4. decline: runtime.apply is never called, agent gets declined_by_user', async () => {
    const f = createCanvasFixture();
    const callsBefore = f.applyCalls.count;
    const csId = f.propose('Will be declined', [{ kind: 'setText', params: { field: 'title', value: 'X' } }]);
    const outcome = (await f.guard.getChangeSet(csId), undefined);
    void outcome;

    f.guard.declineChangeSet(csId, 'nope');

    expect(f.applyCalls.count).toBe(callsBefore);
    expect(f.state.texts.title).toBe('Hello');
    expect(f.guard.getChangeSet(csId)?.status).toBe('declined');
  });

  it('5. mid-commit failure: atomic rollback via inverses, no false receipt', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Will explode', [
      { kind: 'setText', params: { field: 'title', value: 'Applied then rolled back' } },
      { kind: 'boom', params: {} },
    ]);
    const receiptsBefore = f.ui.receipts.length;

    await expect(f.guard.commitChangeSet(csId)).rejects.toThrow('boom');
    // atomic: the first op's effect is gone (rolled back through its inverse)
    expect(f.state.texts.title).toBe('Hello');
    expect(f.ui.receipts.length).toBe(receiptsBefore); // NO receipt
    expect(f.guard.getChangeSet(csId)?.status).toBe('failed');
    expect(f.ui.audit.find((a) => a.kind === 'failed' && a.txId === csId)?.detail?.rolledBack).toBe(1);
  });

  it('6. undo: deterministic inverse replay restores the exact previous state', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Multi-op', [
      { kind: 'setText', params: { field: 'title', value: 'T2' } },
      { kind: 'setFill', params: { target: 'background', value: '#123456' } },
      { kind: 'move', params: { x: 400, y: 200 } },
      { kind: 'resize', params: { size: 120 } },
    ]);
    const receipt = await f.guard.commitChangeSet(csId);
    expect(f.state.texts.title).toBe('T2');
    expect(f.state.box.size).toBe(120);

    const ev = await f.guard.undo(receipt.undoToken);
    expect(f.state.texts.title).toBe('Hello');
    expect(f.state.fills.background).toBe('#ffffff');
    expect(f.state.box).toEqual({ x: 10, y: 10, size: 60 });
    expect(ev.transactionId).toBe(csId);
    expect(f.guard.getChangeSet(csId)?.status).toBe('undone');
    expect(f.ui.audit.some((a) => a.kind === 'rolled_back' && a.txId === csId)).toBe(true);
  });

  it('7. double undo: deterministic ALREADY_UNDONE', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Undo me', [{ kind: 'setText', params: { field: 'title', value: 'X' } }]);
    const receipt = await f.guard.commitChangeSet(csId);
    await f.guard.undo(receipt.undoToken);

    await expect(f.guard.undo(receipt.undoToken)).rejects.toMatchObject({
      name: 'RediniError',
      code: 'ALREADY_UNDONE',
    });
    expect(f.state.texts.title).toBe('Hello');
  });

  it('8. stale guard: state changed between proposal and commit → STALE_TRANSACTION, nothing applied', async () => {
    const f = createCanvasFixture();
    const p1 = f.guard.dispatch('design_update', {
      intent: 'First',
      operations: [{ kind: 'setText', params: { field: 'title', value: 'First' } }],
    }) as Promise<AgentOutcome>;
    const cs1 = f.ui.lastChangeSetId();
    const p2 = f.guard.dispatch('design_update', {
      intent: 'Second',
      operations: [{ kind: 'setText', params: { field: 'title', value: 'Second' } }],
    }) as Promise<AgentOutcome>;
    const cs2 = f.ui.lastChangeSetId();

    await f.guard.commitChangeSet(cs1);
    const callsBefore = f.applyCalls.count;
    await expect(f.guard.commitChangeSet(cs2)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(f.applyCalls.count).toBe(callsBefore);
    expect(f.state.texts.title).toBe('First');
    expect(await p2).toMatchObject({ status: 'stale_transaction', txId: cs2 });
  });

  it('9. two concurrent ChangeSets: first commits, second goes stale', async () => {
    const f = createCanvasFixture();
    const pA = f.guard.dispatch('design_update', {
      intent: 'A',
      operations: [{ kind: 'setFill', params: { target: 'background', value: '#111111' } }],
    }) as Promise<AgentOutcome>;
    const csA = f.ui.lastChangeSetId();
    const pB = f.guard.dispatch('design_update', {
      intent: 'B',
      operations: [{ kind: 'setFill', params: { target: 'background', value: '#222222' } }],
    }) as Promise<AgentOutcome>;
    const csB = f.ui.lastChangeSetId();

    await f.guard.commitChangeSet(csA);
    await expect(f.guard.commitChangeSet(csB)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(f.state.fills.background).toBe('#111111');
    expect(f.applyCalls.count).toBe(1);
    expect(await pA).toMatchObject({ status: 'committed' });
    expect(await pB).toMatchObject({ status: 'stale_transaction' });
  });

  it('10. AbortSignal while pending: cancelled, nothing applied, late decisions fail deterministically', async () => {
    const f = createCanvasFixture();
    const ac = new AbortController();
    const p = f.guard.dispatch(
      'design_update',
      { intent: 'X', operations: [{ kind: 'setText', params: { field: 'title', value: 'X' } }] },
      ac.signal,
    ) as Promise<AgentOutcome>;
    const csId = f.ui.lastChangeSetId();

    ac.abort();
    expect(await p).toMatchObject({ status: 'cancelled', txId: csId });
    expect(f.applyCalls.count).toBe(0);
    expect(f.guard.getChangeSet(csId)?.status).toBe('declined');
    await expect(f.guard.commitChangeSet(csId)).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
  });

  it('11. WebMCP promise resolves ONLY after the human decision, with MCP-shaped content', async () => {
    const f = createCanvasFixture();
    const captured = new Map<string, (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>>();
    const mcp: ModelContextLike = {
      registerTool(tool) {
        captured.set(tool.name, tool.execute as (i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>);
      },
    };
    const guard2 = createGuard({ ui: { onChangesetUpdated: vi.fn(), onReceipt: vi.fn(), onUndo: vi.fn(), onAudit: vi.fn() }, modelContext: mcp });
    const state = { texts: { title: 'Hello' }, version: 0 };
    guard2.registerChangeSetTool({
      name: 'design_update',
      description: 'x',
      kinds: ['setText'],
      runtime: {
        apply(op) {
          const prev = state.texts.title;
          state.texts.title = String(op.params.value);
          state.version += 1;
          return { id: op.id, kind: 'setText', label: op.label, params: { field: 'title', value: prev } };
        },
        simulate: (ops) => state,
      },
    });

    const wrapped = captured.get('design_update')!;
    const p = wrapped(
      { intent: 'x', operations: [{ kind: 'setText', params: { field: 'title', value: 'V' } }] },
      { signal: new AbortController().signal },
    );
    const stillPending = await Promise.race([p.then(() => false), new Promise((r) => setTimeout(() => r(true), 50))]);
    expect(stillPending).toBe(true);

    const csId = guard2.getChangeSets().at(-1)!.id;
    await guard2.commitChangeSet(csId);
    const res = (await p) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0].type).toBe('text');
    const parsed = JSON.parse(res.content[0].text) as { status: string; appliedCount: number };
    expect(parsed.status).toBe('committed');
    expect(parsed.appliedCount).toBe(1);
  });

  it('12. empty subset: committing an all-skipped ChangeSet fails deterministically', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('All skipped', [
      { kind: 'setText', params: { field: 'title', value: 'X' } },
      { kind: 'setFill', params: { target: 'text', value: '#111111' } },
    ]);
    f.guard.toggleOperation(csId, 'op-1', false);
    f.guard.toggleOperation(csId, 'op-2', false);

    await expect(f.guard.commitChangeSet(csId)).rejects.toMatchObject({ code: 'EMPTY_CHANGESET' });
    expect(f.state.texts.title).toBe('Hello');
    expect(f.guard.getChangeSet(csId)?.status).toBe('reviewing'); // still pending, human can re-include
  });

  it('13. safe tool: immediate execution, no ChangeSet staging', async () => {
    const f = createCanvasFixture();
    f.guard.registerSafeTool({
      name: 'peek',
      description: 'Reads the state.',
      execute: () => ({ title: f.state.texts.title }),
    });
    const res = (await f.guard.dispatch('peek', {})) as { title: string };
    expect(res.title).toBe('Hello');
    expect(f.ui.changeSets.size).toBe(0);
  });

  it('14. invalid operations rejected at dispatch: unknown kind / failed validation', async () => {
    const f = createCanvasFixture();
    await expect(
      f.guard.dispatch('design_update', { intent: 'x', operations: [{ kind: 'teleport', params: {} }] }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(
      f.guard.dispatch('design_update', {
        intent: 'x',
        operations: [{ kind: 'setFill', params: { target: 'background', value: 'red' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('15. amend then skip (with another applied op): distance fully recorded in the receipt', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Negotiation', [
      { kind: 'setText', params: { field: 'title', value: 'ORIGINAL' } },
      { kind: 'setFill', params: { target: 'background', value: '#123456' } },
    ]);
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'AMENDED' });
    f.guard.toggleOperation(csId, 'op-1', false);
    const receipt = await f.guard.commitChangeSet(csId);

    expect(receipt.amended).toHaveLength(0); // amended-then-skipped lands in SKIPPED
    expect(receipt.skippedByHuman.map((r) => r.id)).toEqual(['op-1']);
    expect(receipt.applied).toEqual(['op-2']);
    expect(receipt.intended[0].params.value).toBe('ORIGINAL');
    expect(f.state.texts.title).toBe('Hello');
  });
});
