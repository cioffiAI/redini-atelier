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
  const propose = (tool: string, input: Record<string, unknown>): string => {
    const p = guard.dispatch(tool, input) as Promise<unknown>;
    p.catch(() => {});
    return ui.lastTransactionId();
  };
  return { guard, ui, store, propose };
}

describe('Atelier — transactional tools over Redini', () => {
  it('edit_flyer preview: field-level diff + ghost design, nothing applied before commit', async () => {
    const f = setup();
    const before = f.store.design.title;
    const txId = f.propose('edit_flyer', { title: 'New Title', color: '#336699' });

    const preview = f.ui.transactions.get(txId)!.preview;
    expect(preview?.summary).toContain('2 change(s)');
    const changes = (preview!.diff as { changes: Array<{ field: string }> }).changes;
    expect(changes.map((c) => c.field).sort()).toEqual(['color', 'title']);
    const ghost = (preview!.diff as { ghostDesign: { title: string; color: string } }).ghostDesign;
    expect(ghost.title).toBe('New Title');
    expect(ghost.color).toBe('#336699');
    expect(f.store.design.title).toBe(before); // staged, not applied
  });

  it('edit_flyer commit applies only committed fields; audit records humanEdited', async () => {
    const f = setup();
    const txId = f.propose('edit_flyer', { title: 'Agent Title', subtitle: 'Agent sub' });
    await f.guard.commit(txId, { title: 'Human Title', subtitle: 'Agent sub' });

    expect(f.store.design.title).toBe('Human Title');
    expect(f.store.design.subtitle).toBe('Agent sub');
    const audit = f.ui.audit.find((a) => a.kind === 'committed' && a.txId === txId);
    expect(audit?.detail?.humanEdited).toBe(true);
  });

  it('order_prints: commit creates the order; undo removes it (real-world action is reversible)', async () => {
    const f = setup();
    const txId = f.propose('order_prints', { copies: 50, pageSize: 'A4' });
    const receipt = await f.guard.commit(txId);

    expect(f.store.orders.length).toBe(1);
    expect(f.store.orders[0].copies).toBe(50);
    expect((receipt.stateAfter as { orders: unknown[] }).orders.length).toBe(1);

    await f.guard.undo(receipt.undoToken);
    expect(f.store.orders.length).toBe(0);
  });

  it('order_prints preview shows the exact design that would be printed', async () => {
    const f = setup();
    f.store.applyEdit({ title: 'Limited Edition' });
    const txId = f.propose('order_prints', { copies: 25, pageSize: 'Letter' });
    const preview = f.ui.transactions.get(txId)!.preview;
    expect(preview?.summary).toContain('Limited Edition');
    const ghost = (preview!.diff as { ghostDesign: { title: string } }).ghostDesign;
    expect(ghost.title).toBe('Limited Edition');
  });

  it('create_variant: commit registers a dynamic select tool; undo unregisters it', async () => {
    const f = setup();
    f.store.applyEdit({ title: 'Dark Version Base' });
    const txId = f.propose('create_variant', { name: 'Dark version' });
    const receipt = await f.guard.commit(txId);

    expect(f.store.variants.length).toBe(1);
    const toolName = (await Promise.resolve(receipt)) && `select_variant_${f.store.variants[0].n}`;
    const res = (await f.guard.dispatch(toolName, {})) as { design: { title: string } };
    expect(res.design.title).toBe('Dark Version Base');

    await f.guard.undo(receipt.undoToken);
    expect(f.store.variants.length).toBe(0);
    await expect(f.guard.dispatch(toolName, {})).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
  });

  it('apply_template as human action: dispatch + commit applies the preset', async () => {
    const f = setup();
    const txId = f.propose('apply_template', { templateId: 'evening-gala' });
    await f.guard.commit(txId);
    expect(f.store.design.background).toBe('#141420');
    expect(f.store.design.color).toBe('#e8c46a');
    expect(f.store.design.fontFamily).toBe('Georgia, serif');
  });

  it('get_vendor_content: returns the untrusted vendor note (adversarial beat)', async () => {
    const f = setup();
    const res = (await f.guard.dispatch('get_vendor_content', { templateId: 'evening-gala' })) as {
      note: string;
    };
    expect(res.note).toContain('#141420');
    expect(res.note).toContain('MUST'); // the injected instruction is there — for the human to see and decline
  });

  it('edit_flyer on a state modified after proposal: STALE_TRANSACTION', async () => {
    const f = setup();
    const p1 = f.guard.dispatch('edit_flyer', { title: 'A' }) as Promise<unknown>;
    const tx1 = f.ui.lastTransactionId();
    const p2 = f.guard.dispatch('edit_flyer', { title: 'B' }) as Promise<unknown>;
    const tx2 = f.ui.lastTransactionId();

    await f.guard.commit(tx1);
    await expect(f.guard.commit(tx2)).rejects.toMatchObject({ code: 'STALE_TRANSACTION' });
    expect(await p2).toMatchObject({ status: 'stale_transaction' });
    expect(await p1).toMatchObject({ status: 'committed' });
  });
});
