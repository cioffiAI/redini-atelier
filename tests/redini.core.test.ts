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
      if (op.kind === 'move' && (typeof op.params.x !== 'number' || typeof op.params.y !== 'number')) {
        return 'x and y must be numbers';
      }
      if (op.kind === 'resize' && typeof op.params.size !== 'number') {
        return 'size must be a number';
      }
      if (op.kind === 'setFill' && !String(op.params.value).startsWith('#')) {
        return 'fill must be a #rrggbb color';
      }
      if (op.kind === 'setText' && !['title', 'subtitle'].includes(String(op.params.field))) {
        return `unknown text field "${String(op.params.field)}"`;
      }
      if (op.kind === 'setText' && typeof op.params.value !== 'string') {
        return 'value must be a string';
      }
      const allowed = op.kind === 'setText' ? ['field', 'value'] : op.kind === 'setFill' ? ['target', 'value'] : null;
      if (allowed) {
        for (const key of Object.keys(op.params)) {
          if (!allowed.includes(key)) return `unknown parameter "${key}" for ${op.kind}`;
        }
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

/**
 * Fixture for FAILURE-path semantics: a ChangeSet tool whose runtime can be
 * programmed to (a) fail during commit compensation (rollback failure) and
 * (b) fail during undo replay (undo token lifecycle).
 */
function createFailureFixture() {
  const ui = new InMemoryUI();
  let idCounter = 0;
  const guard = createGuard({ ui, idFactory: () => `id-${++idCounter}` });
  const state = { x: 0, version: 0 };
  const simulate = (ops: Array<{ kind: string; params: Record<string, unknown> }>): unknown => {
    const s = structuredClone(state);
    for (const op of ops) s.x = Number(op.params.x ?? s.x);
    return s;
  };
  // Programming knobs.
  const behaviors = {
    failReverseOnUndo: false, // inverse of an 'ok' op throws when replayed (undo path)
    failReverseOnRollback: false, // inverse of an 'ok' op throws during commit compensation
    failForwardOnRedo: false, // forward 'ok' op throws when re-applied (redo path)
    /** When set (and failReverseOnUndo), ONLY this op's inverse throws during undo replay. */
    undoFailOpId: null as string | null,
    /** When set (and failForwardOnRedo), ONLY this op's forward throws during redo replay. */
    redoFailOpId: null as string | null,
    reset(): void {
      this.failReverseOnUndo = false;
      this.failReverseOnRollback = false;
      this.failForwardOnRedo = false;
      this.undoFailOpId = null;
      this.redoFailOpId = null;
    },
  };
  guard.registerChangeSetTool({
    name: 'flaky_design_update',
    description: 'Failure-path test tool.',
    kinds: ['ok', 'applyFails'],
    runtime: {
      apply(op) {
        if (op.kind === 'applyFails') throw new Error('apply boom');
        // 'ok': the forward op sets x; its inverse carries {x: prev, undo: true}.
        const isInverse = op.params.undo === true;
        if (isInverse && behaviors.failReverseOnRollback) throw new Error('compensation boom');
        if (
          isInverse &&
          behaviors.failReverseOnUndo &&
          (behaviors.undoFailOpId === null || op.id === behaviors.undoFailOpId)
        ) {
          throw new Error('undo replay boom');
        }
        if (
          !isInverse &&
          behaviors.failForwardOnRedo &&
          (behaviors.redoFailOpId === null || op.id === behaviors.redoFailOpId)
        ) {
          throw new Error('redo replay boom');
        }
        const prev = state.x;
        state.x = Number(op.params.x);
        state.version += 1;
        return { id: op.id, kind: 'ok', label: op.label, originalLabel: op.originalLabel, params: { x: prev, undo: true } };
      },
      simulate,
    },
    getStateVersion: () => state.version,
  });
  const propose = (operations: Array<{ kind: string; params: Record<string, unknown> }>): string => {
    const p = guard.dispatch('flaky_design_update', { intent: 'x', operations }) as Promise<AgentOutcome>;
    p.catch(() => {});
    return ui.lastChangeSetId();
  };
  return { guard, ui, state, behaviors, propose };
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
    expect(receipt.applied.map((r) => r.id)).toEqual(['op-1', 'op-2', 'op-3']);
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
    expect(receipt.intended.find((r) => r.id === 'op-1')?.label).toContain('AGENT VERSION');
    expect(receipt.amended.find((r) => r.id === 'op-1')?.params.value).toBe('HUMAN VERSION');
    expect(receipt.amended.find((r) => r.id === 'op-1')?.originalParams?.value).toBe('AGENT VERSION');
    expect(receipt.amended.find((r) => r.id === 'op-1')?.label).toContain('HUMAN VERSION');
    expect(receipt.amended.find((r) => r.id === 'op-1')?.originalLabel).toContain('AGENT VERSION');
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
    expect(receipt.applied.map((r) => r.id)).toEqual(['op-1', 'op-3']);
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

  it('5. mid-commit failure: atomic rollback via inverses, no false receipt, EXECUTION_FAILED', async () => {
    const f = createCanvasFixture();
    const receiptsBefore = f.ui.receipts.length;
    const p = f.guard.dispatch('design_update', {
      intent: 'Will explode',
      operations: [
        { kind: 'setText', params: { field: 'title', value: 'Applied then rolled back' } },
        { kind: 'boom', params: {} },
      ],
    }) as Promise<AgentOutcome>;
    const csId = f.ui.lastChangeSetId();

    const err = await f.guard.commitChangeSet(csId).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'RediniError', code: 'EXECUTION_FAILED' });
    expect(String((err as Error).message)).toContain('boom');
    // atomic: the first op's effect is gone (rolled back through its inverse)
    expect(f.state.texts.title).toBe('Hello');
    expect(f.ui.receipts.length).toBe(receiptsBefore); // NO receipt
    expect(f.guard.getChangeSet(csId)?.status).toBe('failed');
    expect(f.ui.audit.find((a) => a.kind === 'failed' && a.txId === csId)?.detail?.rolledBack).toBe(1);
    // the agent promise settled exactly once, with the typed EXECUTION_FAILED code
    expect(await p).toMatchObject({
      status: 'execute_failed',
      changeSetId: csId,
      error: { code: 'EXECUTION_FAILED' },
    });
  });

  it('6. undo: deterministic inverse replay restores the exact previous state', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Multi-op', [
      { kind: 'setText', params: { field: 'title', value: 'T2' } },
      { kind: 'setFill', params: { target: 'background', value: '#123456' } },
      { kind: 'move', params: { x: 400, y: 200 } },
      { kind: 'resize', params: { size: 120 } },
    ]);
    await f.guard.commitChangeSet(csId);
    expect(f.state.texts.title).toBe('T2');
    expect(f.state.box.size).toBe(120);

    const ev = await f.guard.undo();
    expect(f.state.texts.title).toBe('Hello');
    expect(f.state.fills.background).toBe('#ffffff');
    expect(f.state.box).toEqual({ x: 10, y: 10, size: 60 });
    expect(ev.transactionId).toBe(csId);
    expect(f.guard.getChangeSet(csId)?.status).toBe('undone');
    expect(f.ui.audit.some((a) => a.kind === 'undone' && a.txId === csId)).toBe(true);
  });

  it('7. double undo after a single commit: deterministic NOTHING_TO_UNDO, state untouched', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Undo me', [{ kind: 'setText', params: { field: 'title', value: 'X' } }]);
    await f.guard.commitChangeSet(csId);
    await f.guard.undo();
    expect(f.state.texts.title).toBe('Hello');

    await expect(f.guard.undo()).rejects.toMatchObject({
      name: 'RediniError',
      code: 'NOTHING_TO_UNDO',
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
    expect(await p1).toMatchObject({ status: 'committed', changeSetId: cs1 });
    expect(await p2).toMatchObject({ status: 'stale_transaction', changeSetId: cs2 });
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
    expect(await pA).toMatchObject({ status: 'committed', changeSetId: csA });
    expect(await pB).toMatchObject({ status: 'stale_transaction', changeSetId: csB });
  });

  it('10. AbortSignal while pending: cancelled, UI notified, nothing applied, late decisions fail deterministically', async () => {
    const f = createCanvasFixture();
    const ac = new AbortController();
    const p = f.guard.dispatch(
      'design_update',
      { intent: 'X', operations: [{ kind: 'setText', params: { field: 'title', value: 'X' } }] },
      ac.signal,
    ) as Promise<AgentOutcome>;
    const csId = f.ui.lastChangeSetId();

    ac.abort();
    expect(await p).toMatchObject({ status: 'cancelled', changeSetId: csId });
    expect(f.applyCalls.count).toBe(0);
    expect(f.guard.getChangeSet(csId)?.status).toBe('cancelled');
    // the abort emitted a UI update: subscribers see the 'cancelled' status
    expect(f.ui.changeSets.get(csId)?.changeset.status).toBe('cancelled');
    await expect(f.guard.commitChangeSet(csId)).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
  });

  it('11. WebMCP execute promise resolves ONLY after the human decision, with a DIRECT structured result (no envelope)', async () => {
    const captured = new Map<string, (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>>();
    const mcp: ModelContextLike = {
      registerTool(tool) {
        captured.set(tool.name, tool.execute as (i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>);
      },
    };
    const guard2 = createGuard({ ui: { onChangesetUpdated: vi.fn(), onReceipt: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onAudit: vi.fn() }, modelContext: mcp });
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
          return { id: op.id, kind: 'setText', label: op.label, originalLabel: op.originalLabel, params: { field: 'title', value: prev } };
        },
        simulate: () => state,
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
    // DIRECT structured summary — no {content:[{type:'text',...}]} envelope.
    const res = (await p) as {
      status: string;
      changeSetId: string;
      appliedCount: number;
      amendedCount: number;
      skippedCount: number;
      undoAvailable: boolean;
    };
    expect(res.status).toBe('committed');
    expect(res.changeSetId).toBe(csId);
    expect(res.appliedCount).toBe(1);
    expect(res.amendedCount).toBe(0);
    expect(res.skippedCount).toBe(0);
    expect(res.undoAvailable).toBe(true);

    // Pre-staging validation failure: the execute callback NEVER rejects — it
    // resolves with status 'execute_failed' and the typed INVALID_OPERATION code.
    const bad = await wrapped(
      { intent: 'x', operations: [{ kind: 'nope', params: {} }] },
      { signal: new AbortController().signal },
    );
    expect(bad).toMatchObject({ status: 'execute_failed', error: { code: 'INVALID_OPERATION' } });
  });

  it('12. empty subset: committing an all-skipped ChangeSet fails deterministically and stays pending', async () => {
    const f = createCanvasFixture();
    const p = f.guard.dispatch('design_update', {
      intent: 'All skipped',
      operations: [
        { kind: 'setText', params: { field: 'title', value: 'X' } },
        { kind: 'setFill', params: { target: 'text', value: '#111111' } },
      ],
    }) as Promise<AgentOutcome>;
    const csId = f.ui.lastChangeSetId();
    f.guard.toggleOperation(csId, 'op-1', false);
    f.guard.toggleOperation(csId, 'op-2', false);

    await expect(f.guard.commitChangeSet(csId)).rejects.toMatchObject({ code: 'EMPTY_CHANGESET' });
    expect(f.state.texts.title).toBe('Hello');
    expect(f.guard.getChangeSet(csId)?.status).toBe('reviewing'); // still pending, human can re-include
    // EMPTY_CHANGESET is a human-UI error: the agent promise is NOT settled.
    const stillPending = await Promise.race([p.then(() => false), new Promise((r) => setTimeout(() => r(true), 50))]);
    expect(stillPending).toBe(true);
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

  it('14. invalid operations rejected at dispatch: unknown kind / failed validation / extra param keys', async () => {
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
    await expect(
      f.guard.dispatch('design_update', {
        intent: 'x',
        operations: [{ kind: 'setFill', params: { target: 'background', value: '#112233', extra: true } }],
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
    expect(receipt.applied.map((r) => r.id)).toEqual(['op-2']);
    expect(receipt.intended[0].params.value).toBe('ORIGINAL');
    expect(f.state.texts.title).toBe('Hello');
  });

  it('16. invalid amendment: rejected with INVALID_AMENDMENT, operation NOT mutated, label stays the original until a valid amend', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Amend guard', [
      { kind: 'setText', params: { field: 'title', value: 'ORIGINAL' } },
    ]);

    const opBefore = f.guard.getChangeSet(csId)!.operations[0];
    // (a) non-plain-object params
    expect(() => f.guard.amendOperation(csId, 'op-1', null as unknown as Record<string, unknown>)).toThrowError(
      /INVALID_AMENDMENT/,
    );
    // (b) validate failure (value not a string)
    expect(() => f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 42 })).toThrowError(/INVALID_AMENDMENT/);
    expect(() => f.guard.amendOperation(csId, 'op-1', { field: 'nope', value: 'x' })).toThrowError(/INVALID_AMENDMENT/);
    // nothing mutated by the rejected amendments
    const opAfter = f.guard.getChangeSet(csId)!.operations[0];
    expect(opAfter.params).toEqual(opBefore.params);
    expect(opAfter.label).toBe(opBefore.label);
    expect(opAfter.originalParams).toEqual(opBefore.originalParams);

    // (c) valid amendment: params replaced AND label recomputed from the new params
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'REVISED' });
    const revised = f.guard.getChangeSet(csId)!.operations[0];
    expect(revised.params).toEqual({ field: 'title', value: 'REVISED' });
    expect(revised.label).toContain('REVISED');
    expect(revised.label).not.toContain('ORIGINAL');
    // (d) originalParams / originalLabel immutable
    expect(revised.originalParams).toEqual({ field: 'title', value: 'ORIGINAL' });
    expect(revised.originalLabel).toContain('ORIGINAL');
  });

  it('17. failed undo keeps the entry on the undo stack: canUndo stays true; retry after the fix succeeds', async () => {
    const f = createFailureFixture();
    const csId = f.propose([{ kind: 'ok', params: { x: 7 } }]);
    await f.guard.commitChangeSet(csId);
    expect(f.state.x).toBe(7);

    f.behaviors.failReverseOnUndo = true;
    await expect(f.guard.undo()).rejects.toMatchObject({
      name: 'RediniError',
      code: 'UNDO_FAILED',
    });
    expect(f.guard.getChangeSet(csId)?.status).toBe('undo_failed');
    const audit = f.ui.audit.find((a) => a.kind === 'undo_failed' && a.txId === csId);
    expect(audit?.detail?.attempted).toEqual(['op-1']);
    expect(audit?.detail?.remaining).toEqual([]);

    // Entry NOT popped: a retry (now that the inverse works again) succeeds.
    expect(f.guard.canUndo()).toBe(true);
    f.behaviors.failReverseOnUndo = false;
    const ev = await f.guard.undo();
    expect(ev.transactionId).toBe(csId);
    expect(f.state.x).toBe(0);
    expect(f.guard.getChangeSet(csId)?.status).toBe('undone');
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(true);
  });

  it('18. rollback failure: ROLLBACK_FAILED with a TRUTHFUL audit (rolledBack counts actual successes, rollbackFailed: true)', async () => {
    const f = createFailureFixture();
    const p = f.guard.dispatch('flaky_design_update', {
      intent: 'rollback failure',
      operations: [
        { kind: 'ok', params: { x: 5 } },
        { kind: 'applyFails', params: {} },
      ],
    }) as Promise<AgentOutcome>;
    const csId = f.ui.lastChangeSetId();
    f.behaviors.failReverseOnRollback = true; // compensating the first op fails too

    const err = await f.guard.commitChangeSet(csId).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'RediniError', code: 'ROLLBACK_FAILED' });
    // MINOR 7: the structured bundle travels as `detail`, the real error as `cause`.
    const rediniErr = err as RediniError;
    expect(rediniErr.detail).toEqual({
      appliedOperations: ['op-1'],
      compensatedOperations: [],
      failedCompensation: 'op-1',
    });
    expect(rediniErr.cause).toBeInstanceOf(Error);
    expect(f.guard.getChangeSet(csId)?.status).toBe('failed');
    const audit = f.ui.audit.find((a) => a.kind === 'failed' && a.txId === csId);
    expect(audit?.detail?.rolledBack).toBe(0); // the ONLY compensation attempt failed — no false count
    expect(audit?.detail?.rollbackFailed).toBe(true);
    expect(audit?.detail?.failedCompensation).toBe('op-1');
    // the agent promise settled exactly once with the typed ROLLBACK_FAILED code
    expect(await p).toMatchObject({
      status: 'execute_failed',
      changeSetId: csId,
      error: { code: 'ROLLBACK_FAILED' },
    });
  });

  it('19. amend with valid params on an untouched op keeps the amended flag false (identity amendment)', () => {
    const f = createCanvasFixture();
    const csId = f.propose('Identity', [{ kind: 'setText', params: { field: 'title', value: 'SAME' } }]);
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'SAME' });
    const op = f.guard.getChangeSet(csId)!.operations[0];
    expect(op.amended).toBe(false);
    expect(op.originalLabel).toBe(op.label);
  });

  it('20. empty history: undo and redo both fail deterministically with NOTHING_TO_*', async () => {
    const f = createCanvasFixture();
    await expect(f.guard.undo()).rejects.toMatchObject({
      name: 'RediniError',
      code: 'NOTHING_TO_UNDO',
    });
    await expect(f.guard.redo()).rejects.toMatchObject({
      name: 'RediniError',
      code: 'NOTHING_TO_REDO',
    });
  });

  it('21. ALREADY_DECIDED on amendOperation AND toggleOperation after the changeset was committed', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Decided', [{ kind: 'setText', params: { field: 'title', value: 'X' } }]);
    await f.guard.commitChangeSet(csId);
    expect(() => f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'Y' })).toThrowError(
      /ALREADY_DECIDED/,
    );
    expect(() => f.guard.toggleOperation(csId, 'op-1', false)).toThrowError(/ALREADY_DECIDED/);
  });

  it('22. mutationCounter-only staleness: the internal counter guards even when the app never bumps a version', async () => {
    const ui = new InMemoryUI();
    const guard = createGuard({ ui });
    const state = { v: 0 };
    // A changeset tool WITHOUT getStateVersion: only Redini's own counter protects it.
    guard.registerChangeSetTool({
      name: 'no_version_tool',
      description: 'Tool without getStateVersion.',
      kinds: ['set'],
      runtime: {
        apply(op) {
          state.v = Number(op.params.n);
          return { id: op.id, kind: 'set', label: op.label, params: { n: state.v } };
        },
        simulate: () => state,
      },
    });
    const p1 = guard.dispatch('no_version_tool', {
      intent: 'First',
      operations: [{ kind: 'set', params: { n: 1 } }],
    }) as Promise<AgentOutcome>;
    const cs1 = ui.lastChangeSetId();
    const p2 = guard.dispatch('no_version_tool', {
      intent: 'Second',
      operations: [{ kind: 'set', params: { n: 2 } }],
    }) as Promise<AgentOutcome>;
    const cs2 = ui.lastChangeSetId();

    await guard.commitChangeSet(cs1);
    expect(state.v).toBe(1);
    await expect(guard.commitChangeSet(cs2)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(state.v).toBe(1); // nothing applied
    expect(await p1).toMatchObject({ status: 'committed', changeSetId: cs1 });
    expect(await p2).toMatchObject({ status: 'stale_transaction', changeSetId: cs2 });
  });

  it('23. dispatch rejects unknown operation-level keys (additionalProperties:false parity)', async () => {
    const f = createCanvasFixture();
    await expect(
      f.guard.dispatch('design_update', {
        intent: 'x',
        operations: [{ kind: 'setText', params: { field: 'title', value: 'X' }, note: 'extra' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('24. dispatch rejects a missing intent (schema required parity) instead of defaulting', async () => {
    const f = createCanvasFixture();
    await expect(
      f.guard.dispatch('design_update', {
        operations: [{ kind: 'setText', params: { field: 'title', value: 'X' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    // no changeset was staged by the rejected dispatch
    expect(f.ui.changeSets.size).toBe(0);
  });

  it('25. validator parity: move with a string x is rejected, not coerced', async () => {
    const f = createCanvasFixture();
    await expect(
      f.guard.dispatch('design_update', {
        intent: 'x',
        operations: [{ kind: 'move', params: { x: '40', y: 30 } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(
      f.guard.dispatch('design_update', {
        intent: 'x',
        operations: [{ kind: 'resize', params: { size: '120' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('26. multi-op undo failure: TRUTHFUL attempted/remaining audit, entry retained on the undo stack', async () => {
    const f = createFailureFixture();
    const csId = f.propose([
      { kind: 'ok', params: { x: 1 } },
      { kind: 'ok', params: { x: 2 } },
      { kind: 'ok', params: { x: 3 } },
    ]);
    await f.guard.commitChangeSet(csId);
    expect(f.state.x).toBe(3);

    // Only the inverse of op-2 throws during undo replay: op-3's replay succeeds.
    f.behaviors.failReverseOnUndo = true;
    f.behaviors.undoFailOpId = 'op-2';
    const err = await f.guard.undo().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'RediniError', code: 'UNDO_FAILED' });
    expect(String((err as Error).message)).toContain('failed after 1 successful compensations');
    const rediniErr = err as RediniError;
    expect(rediniErr.detail?.attempted).toEqual(['op-3', 'op-2']);
    expect(rediniErr.detail?.remaining).toEqual(['op-1']);
    expect(rediniErr.cause).toBeInstanceOf(Error);
    // the audit carries the same truthful bundle
    const audit = f.ui.audit.find((a) => a.kind === 'undo_failed' && a.txId === csId);
    expect(audit?.detail?.attempted).toEqual(['op-3', 'op-2']);
    expect(audit?.detail?.remaining).toEqual(['op-1']);
    // partial replay happened exactly once: op-3's inverse restored x to 2
    expect(f.state.x).toBe(2);
    expect(f.guard.getChangeSet(csId)?.status).toBe('undo_failed');
    // retry-safe: the entry stays on the undo stack — never NOTHING_TO_UNDO.
    expect(f.guard.canUndo()).toBe(true);

    // The second attempt fails with UNDO_FAILED again — the guard never lies.
    await expect(f.guard.undo()).rejects.toMatchObject({ code: 'UNDO_FAILED' });

    // Once the failure is fixed the SAME entry replays cleanly to the end.
    f.behaviors.failReverseOnUndo = false;
    const ev = await f.guard.undo();
    expect(ev.transactionId).toBe(csId);
    expect(f.state.x).toBe(0);
    expect(f.guard.getChangeSet(csId)?.status).toBe('undone');
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(true);
  });

  it('27. canUndo/canRedo transitions: false initially, true after commit, false+true after undo, true+false after redo', async () => {
    const f = createCanvasFixture();
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(false);

    const csId = f.propose('Transitions', [{ kind: 'setText', params: { field: 'title', value: 'V1' } }]);
    await f.guard.commitChangeSet(csId);
    expect(f.guard.canUndo()).toBe(true);
    expect(f.guard.canRedo()).toBe(false);

    await f.guard.undo();
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(true);

    await f.guard.redo();
    expect(f.guard.canUndo()).toBe(true);
    expect(f.guard.canRedo()).toBe(false);
  });

  it('28. three commits → three sequential undos, each restoring the exact intermediate state; then NOTHING_TO_UNDO', async () => {
    const f = createCanvasFixture();
    const designOf = (): unknown =>
      structuredClone({ texts: f.state.texts, fills: f.state.fills, font: f.state.font, box: f.state.box });
    const s0 = designOf();

    const csA = f.propose('A', [{ kind: 'setText', params: { field: 'title', value: 'A' } }]);
    await f.guard.commitChangeSet(csA);
    const sA = designOf();
    const csB = f.propose('B', [{ kind: 'setFill', params: { target: 'background', value: '#111111' } }]);
    await f.guard.commitChangeSet(csB);
    const sB = designOf();
    const csC = f.propose('C', [{ kind: 'move', params: { x: 300, y: 300 } }]);
    await f.guard.commitChangeSet(csC);
    const sC = designOf();
    expect(f.guard.canUndo()).toBe(true);

    await f.guard.undo();
    expect(designOf()).toEqual(sB);
    expect(f.guard.getChangeSet(csC)?.status).toBe('undone');
    await f.guard.undo();
    expect(designOf()).toEqual(sA);
    expect(f.guard.getChangeSet(csB)?.status).toBe('undone');
    await f.guard.undo();
    expect(designOf()).toEqual(s0);
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(true);
    void csA;
    void sC;
    await expect(f.guard.undo()).rejects.toMatchObject({ code: 'NOTHING_TO_UNDO' });
  });

  it('29. A→B→C commits, undo, undo, redo → state === B exactly', async () => {
    const f = createCanvasFixture();
    const designOf = (): unknown =>
      structuredClone({ texts: f.state.texts, fills: f.state.fills, font: f.state.font, box: f.state.box });
    const csA = f.propose('A', [{ kind: 'setText', params: { field: 'title', value: 'A' } }]);
    await f.guard.commitChangeSet(csA);
    const csB = f.propose('B', [{ kind: 'setFill', params: { target: 'background', value: '#222222' } }]);
    await f.guard.commitChangeSet(csB);
    const sB = designOf();
    const csC = f.propose('C', [{ kind: 'move', params: { x: 250, y: 250 } }]);
    await f.guard.commitChangeSet(csC);

    await f.guard.undo(); // → B
    await f.guard.undo(); // → A
    await f.guard.redo(); // → B again
    expect(designOf()).toEqual(sB);
    expect(f.guard.getChangeSet(csB)?.status).toBe('committed');
    expect(f.guard.getChangeSet(csC)?.status).toBe('undone');
    void csA;
  });

  it('30. a new commit after an undo invalidates the redo future: canRedo false, redo throws NOTHING_TO_REDO', async () => {
    const f = createCanvasFixture();
    const csA = f.propose('A', [{ kind: 'setText', params: { field: 'title', value: 'A' } }]);
    await f.guard.commitChangeSet(csA);
    const csB = f.propose('B', [{ kind: 'setText', params: { field: 'title', value: 'B' } }]);
    await f.guard.commitChangeSet(csB);

    await f.guard.undo(); // → A; B is the redo future
    expect(f.guard.canRedo()).toBe(true);
    const csD = f.propose('D', [{ kind: 'setFill', params: { target: 'background', value: '#DDDDDD' } }]);
    await f.guard.commitChangeSet(csD);

    expect(f.guard.canRedo()).toBe(false);
    await expect(f.guard.redo()).rejects.toMatchObject({ code: 'NOTHING_TO_REDO' });
    expect(f.state.texts.title).toBe('A'); // B was never re-applied
    expect(f.state.fills.background).toBe('#DDDDDD'); // D committed on top of A
    void csB;
  });

  it('31. failed redo: redoStack retained, cs stays undone, TRUTHFUL redo_failed audit, retry succeeds', async () => {
    const f = createFailureFixture();
    const csId = f.propose([
      { kind: 'ok', params: { x: 1 } },
      { kind: 'ok', params: { x: 2 } },
      { kind: 'ok', params: { x: 3 } },
    ]);
    await f.guard.commitChangeSet(csId);
    await f.guard.undo();
    expect(f.state.x).toBe(0);
    expect(f.guard.canRedo()).toBe(true);

    // op-2's FORWARD apply throws on re-appliance: op-1's replay already ran.
    f.behaviors.failForwardOnRedo = true;
    f.behaviors.redoFailOpId = 'op-2';
    const err = await f.guard.redo().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'RediniError', code: 'REDO_FAILED' });
    expect(String((err as Error).message)).toContain('failed after 1 successful replays');
    const rediniErr = err as RediniError;
    expect(rediniErr.detail?.attempted).toEqual(['op-1', 'op-2']);
    expect(rediniErr.detail?.remaining).toEqual(['op-3']);
    expect(rediniErr.cause).toBeInstanceOf(Error);
    const audit = f.ui.audit.find((a) => a.kind === 'redo_failed' && a.txId === csId);
    expect(audit?.detail?.attempted).toEqual(['op-1', 'op-2']);
    expect(audit?.detail?.remaining).toEqual(['op-3']);
    // partial replay: op-1 applied (x=1), op-2 failed before mutating
    expect(f.state.x).toBe(1);
    expect(f.guard.getChangeSet(csId)?.status).toBe('undone'); // stays undone
    expect(f.guard.canRedo()).toBe(true); // entry retained on the redo stack

    // Retry is safe (set-semantics forwards): the SAME entry converges.
    f.behaviors.failForwardOnRedo = false;
    const ev = await f.guard.redo();
    expect(ev.transactionId).toBe(csId);
    expect(f.state.x).toBe(3);
    expect(f.guard.getChangeSet(csId)?.status).toBe('committed');
    expect(f.guard.canRedo()).toBe(false);
    expect(f.guard.canUndo()).toBe(true);
  });

  it('32. undo and redo each bump the app stateVersion monotonically', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Versions', [{ kind: 'setText', params: { field: 'title', value: 'V' } }]);
    await f.guard.commitChangeSet(csId);
    const vCommit = f.state.version;
    await f.guard.undo();
    expect(f.state.version).toBeGreaterThan(vCommit);
    const vUndo = f.state.version;
    await f.guard.redo();
    expect(f.state.version).toBeGreaterThan(vUndo);
  });

  it('33. pending proposal goes stale after an undo of another entry: isStale true, commit rejected with no mutation', async () => {
    const f = createCanvasFixture();
    const csA = f.propose('A', [{ kind: 'setText', params: { field: 'title', value: 'A' } }]);
    await f.guard.commitChangeSet(csA);

    const csX = f.propose('X', [{ kind: 'setText', params: { field: 'title', value: 'X' } }]);
    expect(f.guard.getChangeSet(csX)?.isStale).toBe(false);
    expect(f.ui.changeSets.get(csX)?.changeset.isStale).toBe(false);

    await f.guard.undo(); // state moved under X

    expect(f.guard.getChangeSet(csX)?.isStale).toBe(true);
    expect(f.ui.changeSets.get(csX)?.changeset.isStale).toBe(true);
    // stale previews are still emitted (so the UI can show the hint) but the
    // commit is lazily rejected exactly as before.
    const callsBefore = f.applyCalls.count;
    await expect(f.guard.commitChangeSet(csX)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(f.applyCalls.count).toBe(callsBefore);
    expect(f.state.texts.title).toBe('Hello'); // undo restored; X never applied
    expect(f.guard.getChangeSet(csX)?.status).toBe('stale');
  });

  it('34. receipts are immutable artifacts: a single onReceipt emission; content unchanged after undo+redo', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Receipt immutability', [{ kind: 'setText', params: { field: 'title', value: 'AGENT' } }]);
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'HUMAN' });
    const receipt = await f.guard.commitChangeSet(csId);
    const receiptSnapshot = structuredClone(receipt);
    const emissionsBefore = f.ui.receipts.length;

    await f.guard.undo();
    await f.guard.redo();

    expect(f.ui.receipts.length).toBe(emissionsBefore); // undo/redo never re-emit
    expect(f.guard.getChangeSet(csId)?.status).toBe('committed');
    expect(structuredClone(f.ui.receipts.at(-1))).toEqual(receiptSnapshot);
    expect(f.state.texts.title).toBe('HUMAN'); // the redo committed the amended value
  });

  it('35. audit trail: distinct committed / undone / redone entries for the same changeSetId', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('Audited', [{ kind: 'setText', params: { field: 'title', value: 'A' } }]);
    await f.guard.commitChangeSet(csId);
    await f.guard.undo();
    await f.guard.redo();

    const kinds = f.ui.audit.filter((a) => a.txId === csId).map((a) => a.kind);
    expect(kinds.filter((k) => k === 'committed')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'undone')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'redone')).toHaveLength(1);
  });

  it('36. getHistory: forwardOperations carry the AMENDED (negotiated) params; inverseOperations are in reverse application order', async () => {
    const f = createCanvasFixture();
    const csId = f.propose('History shape', [
      { kind: 'setText', params: { field: 'title', value: 'AGENT' } },
      { kind: 'move', params: { x: 10, y: 20 } },
    ]);
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'HUMAN' });
    f.guard.amendOperation(csId, 'op-2', { x: 300, y: 200 });
    await f.guard.commitChangeSet(csId);

    const [entry] = f.guard.getHistory();
    expect(f.guard.getHistory()).toHaveLength(1);
    expect(entry.changeSetId).toBe(csId);
    // DIRECT structural assertion: the stored forward set is the NEGOTIATED
    // one — amended params + recomputed labels, not the agent's originals.
    expect(entry.forwardOperations.map((o) => o.id)).toEqual(['op-1', 'op-2']);
    expect(entry.forwardOperations[0].params).toEqual({ field: 'title', value: 'HUMAN' });
    expect(entry.forwardOperations[0].label).toContain('HUMAN');
    expect(entry.forwardOperations[1].params).toEqual({ x: 300, y: 200 });
    // The inverses were collected in application order then REVERSED for replay.
    expect(entry.inverseOperations.map((o) => o.id)).toEqual(['op-2', 'op-1']);
    expect(entry.inverseOperations[0].params).toEqual({ target: 'box', x: 10, y: 10 });
    expect(entry.inverseOperations[1].params).toEqual({ field: 'title', value: 'Hello' });
    // The history receipt is a clone of the emitted one (immune to app-side mutation).
    expect(entry.receipt.transactionId).toBe(csId);
    expect(entry.receipt).toEqual(f.ui.receipts.at(-1));
    expect(entry.receipt).not.toBe(f.ui.receipts.at(-1));
  });

  it('37. failed undo sweeps pending previews: partial replay bumps the version → pending ChangeSet re-emitted as stale', async () => {
    const f = createFailureFixture();
    const cs1 = f.propose([
      { kind: 'ok', params: { x: 1 } },
      { kind: 'ok', params: { x: 2 } },
      { kind: 'ok', params: { x: 3 } },
    ]);
    await f.guard.commitChangeSet(cs1);

    // A pending proposal on the committed state (v3).
    const cs2 = f.propose([{ kind: 'ok', params: { x: 9 } }]);
    expect(f.guard.getChangeSet(cs2)?.isStale).toBe(false);
    const previewRefBefore = f.ui.changeSets.get(cs2)?.preview;

    // FAILED undo: op-3's inverse replays (x 3→2, version bump) then op-2's
    // inverse throws — the state moved under the pending proposal.
    f.behaviors.failReverseOnUndo = true;
    f.behaviors.undoFailOpId = 'op-2';
    await expect(f.guard.undo()).rejects.toMatchObject({ code: 'UNDO_FAILED' });
    expect(f.state.version).toBe(4); // partial replay DID advance the state

    // MAJOR 3: the pending ChangeSet was re-emitted by the failure-path sweep.
    expect(f.guard.getChangeSet(cs2)?.isStale).toBe(true);
    expect(f.ui.changeSets.get(cs2)?.changeset.isStale).toBe(true);
    // …and its preview came through the UI adapter as a FRESH emission.
    const previewAfter = f.ui.changeSets.get(cs2)?.preview;
    expect(previewAfter).not.toBeNull();
    expect(previewAfter).not.toBe(previewRefBefore);
    expect((previewAfter?.diff as { appliedPreview: { x: number } }).appliedPreview.x).toBe(9);

    // Enforcement stays lazy: the stale commit is rejected exactly as before.
    await expect(f.guard.commitChangeSet(cs2)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(f.state.x).toBe(2); // the failed undo left op-3 compensated
  });
});
