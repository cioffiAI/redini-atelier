import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/redini/guard';
import { InMemoryUI } from '../src/redini/ui/in-memory';
import type { ModelContextLike } from '../src/redini/types';
import { AtelierStore } from '../src/atelier/store';
import type { FlyerDesign } from '../src/atelier/store';
import { registerAtelierTools } from '../src/atelier/tools';

const TOOL_SURFACE = [
  'design_update',
  'list_templates',
  'get_current_design',
  'filter_templates',
  'get_vendor_content',
].sort();

function setup() {
  const ui = new InMemoryUI();
  const guard = createGuard({ ui });
  const store = new AtelierStore();
  registerAtelierTools(guard, store);
  const propose = (
    intent: string,
    operations: Array<{ kind: string; params: Record<string, unknown> }>,
  ): string => {
    const p = guard.dispatch('design_update', { intent, operations }) as Promise<unknown>;
    p.catch(() => {});
    return ui.lastChangeSetId();
  };
  return { guard, ui, store, propose };
}

describe('Atelier — design_update ChangeSet over Redini', () => {
  it('preview: simulate produces the ghost design; nothing touches the store before commit', async () => {
    const f = setup();
    const before = f.store.design.title;
    const csId = f.propose('Make the title punchier', [
      { kind: 'setText', params: { field: 'title', value: 'AI SUMMIT' } },
      { kind: 'setFill', params: { target: 'background', value: '#FF0055' } },
    ]);

    const preview = f.ui.changeSets.get(csId)!.preview;
    const ghost = (preview!.diff as { appliedPreview: { title: string; background: string } }).appliedPreview;
    expect(ghost.title).toBe('AI SUMMIT');
    expect(ghost.background).toBe('#FF0055');
    expect(f.store.design.title).toBe(before); // staged, not applied
  });

  it('amend + cherry-pick + atomic commit: receipt records the full negotiation', async () => {
    const f = setup();
    const csId = f.propose('Redesign the poster', [
      { kind: 'setText', params: { field: 'title', value: 'AGENT TITLE' } },
      { kind: 'setFill', params: { target: 'background', value: '#FF0055' } }, // will be amended
      { kind: 'setFill', params: { target: 'text', value: '#FFFFFF' } }, // will be skipped
      { kind: 'move', params: { x: 40, y: 40 } },
    ]);

    // Human amends op-2, skips op-3, keeps op-1 and op-4.
    f.guard.amendOperation(csId, 'op-2', { target: 'background', value: '#C90045' });
    f.guard.toggleOperation(csId, 'op-3', false);
    const receipt = await f.guard.commitChangeSet(csId);

    expect(receipt.intended).toHaveLength(4);
    expect(receipt.amended.map((r) => r.id)).toEqual(['op-2']);
    expect(receipt.amended[0].params.value).toBe('#C90045');
    expect(receipt.amended[0].originalParams?.value).toBe('#FF0055'); // agent value preserved
    expect(receipt.skippedByHuman.map((r) => r.id)).toEqual(['op-3']);
    // APPLIED rows carry the ACTUAL committed values, and the amended op's label
    // reflects the human value — not the agent's original.
    expect(receipt.applied.map((r) => r.id)).toEqual(['op-1', 'op-2', 'op-4']);
    expect(receipt.applied.find((r) => r.id === 'op-2')?.params.value).toBe('#C90045');
    expect(receipt.applied.find((r) => r.id === 'op-2')?.label).toContain('#C90045');
    expect(receipt.intended.find((r) => r.id === 'op-2')?.params.value).toBe('#FF0055');
    expect(receipt.intended.find((r) => r.id === 'op-2')?.label).toContain('#FF0055');

    expect(f.store.design.title).toBe('AGENT TITLE');
    expect(f.store.design.background).toBe('#C90045');
    expect(f.store.design.textColor).not.toBe('#FFFFFF');
    expect(f.store.design.logo.x).toBe(40);
  });

  it('addVariant is no longer part of the vocabulary: rejected at dispatch with INVALID_OPERATION', async () => {
    const f = setup();
    await expect(
      f.guard.dispatch('design_update', {
        intent: 'x',
        operations: [{ kind: 'addVariant', params: { name: 'Dark version' } }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('tool surface is exactly the fixed 5 tools: no dynamic tools ever appear, even after a full flow', async () => {
    const ui = new InMemoryUI();
    const registered: string[] = [];
    const mcp: ModelContextLike = {
      registerTool(tool) {
        registered.push(tool.name);
        if (tool.name === 'design_update') void tool.inputSchema; // schema is registered too
      },
    };
    const guard = createGuard({ ui, modelContext: mcp });
    const store = new AtelierStore();
    registerAtelierTools(guard, store);
    expect(registered.slice().sort()).toEqual(TOOL_SURFACE);

    // Run a full negotiation flow: propose → amend → skip → commit → undo.
    const p = guard.dispatch('design_update', {
      intent: 'A full round trip',
      operations: [
        { kind: 'setText', params: { field: 'title', value: 'T' } },
        { kind: 'setFill', params: { target: 'background', value: '#224466' } },
        { kind: 'move', params: { x: 30, y: 30 } },
      ],
    }) as Promise<unknown>;
    const csId = ui.lastChangeSetId();
    guard.amendOperation(csId, 'op-1', { field: 'title', value: 'U' });
    guard.toggleOperation(csId, 'op-2', false);
    const receipt = await guard.commitChangeSet(csId);
    await guard.undo();
    void receipt;
    void p;

    expect(registered.slice().sort()).toEqual(TOOL_SURFACE); // still exactly 5, no select_variant_N
    expect(registered.some((n) => n.startsWith('select_variant_'))).toBe(false);
  });

  it('design_update registers a strict per-kind inputSchema and rejects schema-violating payloads at dispatch', async () => {
    const ui = new InMemoryUI();
    let inputSchema: unknown = null;
    const mcp: ModelContextLike = {
      registerTool(tool) {
        if (tool.name === 'design_update') inputSchema = tool.inputSchema;
      },
    };
    const guard = createGuard({ ui, modelContext: mcp });
    const store = new AtelierStore();
    registerAtelierTools(guard, store);

    // Guards use a TOOL-PROVIDED strict schema (not the loose generated default).
    const schema = inputSchema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: { operations: { items: { oneOf: Array<{ properties: { kind: { enum: string[] } } }> } } };
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['intent', 'operations']);
    expect(schema.properties.operations.items.oneOf).toHaveLength(5); // one branch per kind

    const f = setup();
    // Representative valid payload passes and stages a ChangeSet.
    const csId = f.propose('Strict but valid', [
      { kind: 'setText', params: { field: 'title', value: 'OK' } },
      { kind: 'setFill', params: { target: 'background', value: '#224466' } },
      { kind: 'setFont', params: { value: 'Courier New, monospace' } },
      { kind: 'move', params: { x: 40, y: 40 } },
      { kind: 'resize', params: { size: 120 } },
    ]);
    expect(f.guard.getChangeSet(csId)?.status).toBe('proposed');

    // Invalid payloads → INVALID_OPERATION at dispatch.
    const invalid: Array<{ kind: string; params: Record<string, unknown> }> = [
      { kind: 'setText', params: { field: 'headline', value: 'x' } }, // bad field enum
      { kind: 'setText', params: { field: 'title' } }, // missing value
      { kind: 'teleport', params: {} }, // unknown kind
      { kind: 'setText', params: { field: 'title', value: 'x', extra: 1 } }, // unknown extra param key
      { kind: 'setFill', params: { target: 'background', value: 'red' } }, // bad color format
      { kind: 'setFont', params: { value: 'Comic Sans' } }, // bad font enum
      { kind: 'move', params: { x: 9999, y: 0 } }, // out of canvas bounds
      { kind: 'move', params: { x: '40', y: 0 } }, // string x — must NOT be coerced
      { kind: 'resize', params: { size: 300 } }, // out of size bounds
      { kind: 'resize', params: { size: '120' } }, // string size — must NOT be coerced
      { kind: 'setFill', params: { target: 'paper', value: '#112233' } }, // bad target enum
    ];
    for (const op of invalid) {
      await expect(f.guard.dispatch('design_update', { intent: 'x', operations: [op] })).rejects.toMatchObject({
        code: 'INVALID_OPERATION',
      });
    }
  });

  it('amend is validated against the tool validator: INVALID_AMENDMENT never mutates, valid amend recomputes the label', async () => {
    const f = setup();
    const csId = f.propose('Amend discipline', [
      { kind: 'setText', params: { field: 'title', value: 'AGENT TITLE' } },
      { kind: 'setFill', params: { target: 'background', value: '#FF0055' } },
    ]);
    const opBefore = f.guard.getChangeSet(csId)!.operations[0];

    expect(() => f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 42 })).toThrowError(/INVALID_AMENDMENT/);
    expect(() => f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'x', sneaky: true })).toThrowError(/INVALID_AMENDMENT/);
    expect(() => f.guard.amendOperation(csId, 'op-1', { field: 'headline', value: 'x' })).toThrowError(/INVALID_AMENDMENT/);
    expect(() => f.guard.amendOperation(csId, 'op-2', { target: 'background', value: 'not-a-color' })).toThrowError(/INVALID_AMENDMENT/);
    expect(() => f.guard.amendOperation(csId, 'op-1', 'nope' as unknown as Record<string, unknown>)).toThrowError(/INVALID_AMENDMENT/);

    // Nothing was mutated: params, label and original params are untouched.
    const opAfter = f.guard.getChangeSet(csId)!.operations[0];
    expect(opAfter.params).toEqual(opBefore.params);
    expect(opAfter.label).toBe(opBefore.label);
    expect(opAfter.originalParams).toEqual(opBefore.originalParams);
    expect(opAfter.params.value).toBe('AGENT TITLE');

    // A valid amendment replaces params and recomputes the label; the panel then
    // shows the amended description everywhere (public changeset + receipt).
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'HUMAN TITLE' });
    const opAmended = f.guard.getChangeSet(csId)!.operations[0];
    expect(opAmended.params.value).toBe('HUMAN TITLE');
    expect(opAmended.label).toContain('HUMAN TITLE');
    expect(opAmended.label).not.toContain('AGENT TITLE');
    expect(opAmended.originalLabel).toContain('AGENT TITLE');
    expect(opAmended.originalParams.value).toBe('AGENT TITLE');

    const receipt = await f.guard.commitChangeSet(csId);
    expect(receipt.applied.find((r) => r.id === 'op-1')?.label).toContain('HUMAN TITLE');
    expect(receipt.amended[0].originalLabel).toContain('AGENT TITLE');
    expect(receipt.amended[0].label).toContain('HUMAN TITLE');
  });

  it('undo replays inverses across a multi-op ChangeSet: exact state restoration', async () => {
    const f = setup();
    const snapshotBefore = structuredClone(f.store.design);
    const csId = f.propose('Remix everything', [
      { kind: 'setText', params: { field: 'title', value: 'Remixed' } },
      { kind: 'setFill', params: { target: 'background', value: '#141420' } },
      { kind: 'setFont', params: { value: 'system-ui, sans-serif' } },
      { kind: 'resize', params: { size: 140 } },
    ]);
    await f.guard.commitChangeSet(csId);
    expect(f.store.design.title).toBe('Remixed');

    await f.guard.undo();
    expect(f.store.design).toEqual(snapshotBefore);
  });

  it('stale guard on the store version: second ChangeSet proposed before the first commit goes stale', async () => {
    const f = setup();
    const p1 = f.guard.dispatch('design_update', {
      intent: 'First',
      operations: [{ kind: 'setText', params: { field: 'title', value: 'First' } }],
    }) as Promise<unknown>;
    const cs1 = f.ui.lastChangeSetId();
    const p2 = f.guard.dispatch('design_update', {
      intent: 'Second',
      operations: [{ kind: 'setText', params: { field: 'title', value: 'Second' } }],
    }) as Promise<unknown>;
    const cs2 = f.ui.lastChangeSetId();

    await f.guard.commitChangeSet(cs1);
    await expect(f.guard.commitChangeSet(cs2)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(f.store.design.title).toBe('First');
    void p1;
    await p2;
  });

  it('get_vendor_content: untrusted note available for the adversarial demo (kept out of the video)', async () => {
    const f = setup();
    const res = (await f.guard.dispatch('get_vendor_content', { templateId: 'evening-gala' })) as {
      note: string;
    };
    expect(res.note).toContain('#141420');
    expect(res.note).toContain('MUST');
  });

  it('humanApply flow: a template is a 3-op ChangeSet committed instantly', async () => {
    const f = setup();
    const csId = f.propose('Apply template "Evening Gala"', [
      { kind: 'setFill', params: { target: 'background', value: '#141420' } },
      { kind: 'setFill', params: { target: 'text', value: '#e8c46a' } },
      { kind: 'setFont', params: { value: 'Georgia, serif' } },
    ]);
    const receipt = await f.guard.commitChangeSet(csId);
    expect(f.store.design.background).toBe('#141420');
    expect(f.store.design.textColor).toBe('#e8c46a');
    expect(receipt.applied.map((r) => r.id)).toEqual(['op-1', 'op-2', 'op-3']);
  });

  // ---------- preview coherence (the staged render is ONE derived state) ----------

  it('preview coherence: staged setText shows ONLY the proposed title; the store is untouched', () => {
    const f = setup();
    const before = structuredClone(f.store.design);
    const csId = f.propose('Title only', [{ kind: 'setText', params: { field: 'title', value: 'PROPOSED' } }]);
    const ghost = (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview;
    expect(ghost.title).toBe('PROPOSED');
    expect(f.store.design).toEqual(before); // staged, not applied
  });

  it('preview coherence: staged move shows ONLY the proposed logo position', () => {
    const f = setup();
    const csId = f.propose('Move logo', [{ kind: 'move', params: { x: 12, y: 34 } }]);
    const ghost = (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview;
    expect(ghost.logo).toEqual({ x: 12, y: 34, size: 72 }); // proposed position only
  });

  it('preview coherence: an amendment is reflected in the preview IMMEDIATELY', () => {
    const f = setup();
    const csId = f.propose('Amend preview', [{ kind: 'setText', params: { field: 'title', value: 'AGENT' } }]);
    const ghostBefore = (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview;
    expect(ghostBefore.title).toBe('AGENT');

    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'HUMAN' });
    const ghostAfter = (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview;
    expect(ghostAfter.title).toBe('HUMAN');
  });

  it('preview coherence: toggling an op off removes its effect from the preview; re-including restores it', () => {
    const f = setup();
    const csId = f.propose('Toggle skip', [{ kind: 'setText', params: { field: 'title', value: 'X' } }]);
    expect(
      (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview.title,
    ).toBe('X');

    f.guard.toggleOperation(csId, 'op-1', false);
    expect(
      (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview.title,
    ).toBe('Spring Market on Main Street'); // back to the committed value

    f.guard.toggleOperation(csId, 'op-1', true);
    expect(
      (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview.title,
    ).toBe('X');
  });

  it('preview coherence: decline removes the preview entirely; committed design untouched', async () => {
    const f = setup();
    const before = structuredClone(f.store.design);
    const csId = f.propose('Declined preview', [{ kind: 'setText', params: { field: 'title', value: 'NOPE' } }]);
    expect(f.ui.changeSets.get(csId)!.preview).not.toBeNull();

    f.guard.declineChangeSet(csId, 'no thanks');
    // a decided ChangeSet carries NO preview — the ghost must be gone entirely
    expect(f.ui.changeSets.get(csId)?.preview).toBeNull();
    expect(f.store.design).toEqual(before);
    expect(f.guard.getChangeSet(csId)?.status).toBe('declined');
  });

  it('history: commit → undo → redo replays the EXACT negotiated forward set (amended values)', async () => {
    const f = setup();
    const csId = f.propose('Amend round trip', [
      { kind: 'setText', params: { field: 'title', value: 'AGENT TITLE' } },
      { kind: 'move', params: { x: 40, y: 40 } },
    ]);
    f.guard.amendOperation(csId, 'op-1', { field: 'title', value: 'HUMAN TITLE' });
    f.guard.amendOperation(csId, 'op-2', { x: 120, y: 90 });
    const lastPreview = structuredClone(
      (f.ui.changeSets.get(csId)!.preview!.diff as { appliedPreview: FlyerDesign }).appliedPreview,
    );

    const receipt = await f.guard.commitChangeSet(csId);
    // the committed state EXACTLY equals the last previewed state
    expect(structuredClone(f.store.design)).toEqual(lastPreview);
    expect(f.store.design.title).toBe('HUMAN TITLE');
    expect(f.store.design.logo).toEqual({ x: 120, y: 90, size: 72 });
    void receipt;

    await f.guard.undo();
    expect(f.store.design.title).toBe('Spring Market on Main Street');
    expect(f.store.design.logo).toEqual({ x: 500, y: 40, size: 72 });
    expect(f.guard.getChangeSet(csId)?.status).toBe('undone');

    await f.guard.redo();
    // redo replays the STORED forward operations: the AMENDED values, not the
    // agent's originals.
    expect(f.store.design.title).toBe('HUMAN TITLE');
    expect(f.store.design.logo).toEqual({ x: 120, y: 90, size: 72 });
    expect(f.guard.getChangeSet(csId)?.status).toBe('committed');
  });

  it('history: a new commit after undo clears the redo stack; canRedo/canUndo flip with the stacks', async () => {
    const f = setup();
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(false);

    const csA = f.propose('A', [{ kind: 'setText', params: { field: 'title', value: 'A' } }]);
    await f.guard.commitChangeSet(csA);
    expect(f.guard.canUndo()).toBe(true);
    expect(f.guard.canRedo()).toBe(false);

    await f.guard.undo();
    expect(f.guard.canUndo()).toBe(false);
    expect(f.guard.canRedo()).toBe(true);

    const csB = f.propose('B', [{ kind: 'setText', params: { field: 'title', value: 'B' } }]);
    await f.guard.commitChangeSet(csB);
    expect(f.guard.canRedo()).toBe(false); // the undone future is gone
    expect(f.guard.canUndo()).toBe(true);
    expect(f.store.design.title).toBe('B');
    void csA;
    void csB;
  });
});
