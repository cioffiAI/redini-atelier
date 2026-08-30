import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/redini/guard';
import { InMemoryUI } from '../src/redini/ui/in-memory';
import { AtelierStore } from '../src/atelier/store';
import { registerAtelierTools } from '../src/atelier/tools';

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
    expect(receipt.skippedByHuman.map((r) => r.id)).toEqual(['op-3']);
    expect(receipt.applied).toEqual(['op-1', 'op-2', 'op-4']);

    expect(f.store.design.title).toBe('AGENT TITLE');
    expect(f.store.design.background).toBe('#C90045');
    expect(f.store.design.textColor).not.toBe('#FFFFFF');
    expect(f.store.design.logo.x).toBe(40);
  });

  it('addVariant op: commit registers a dynamic view tool; undo removes variant and unregisters it', async () => {
    const f = setup();
    const csId = f.propose('Save this look as a variant', [
      { kind: 'addVariant', params: { name: 'Dark version' } },
    ]);
    const receipt = await f.guard.commitChangeSet(csId);

    expect(f.store.variants.length).toBe(1);
    const toolName = `select_variant_${f.store.variants[0].n}`;
    const view = (await f.guard.dispatch(toolName, {})) as { design: { title: string } };
    expect(view.design.title).toBe(f.store.variants[0].design.title);

    await f.guard.undo(receipt.undoToken);
    expect(f.store.variants.length).toBe(0);
    await expect(f.guard.dispatch(toolName, {})).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
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

    const receipt = f.ui.receipts.at(-1)!;
    await f.guard.undo(receipt.undoToken);
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
    expect(receipt.applied).toEqual(['op-1', 'op-2', 'op-3']);
  });
});
