import { createGuard } from '../src/redini/guard';
import { InMemoryUI } from '../src/redini/ui/in-memory';

/**
 * Minimal domain-agnostic fixture: a counter with two transactional tools.
 * If the core passes every gate test against this, Redini is a library —
 * Atelier is only its showcase.
 */
export interface CounterFixture {
  guard: ReturnType<typeof createGuard>;
  ui: InMemoryUI;
  getCount: () => number;
  setCount: (v: number) => void;
  calls: { setCount: number; boom: number };
  /** Fire a transactional proposal WITHOUT awaiting it (it stays pending until a human decides) and return its txId. */
  propose: (tool: string, input: Record<string, unknown>) => string;
}

export function createCounterFixture(): CounterFixture {
  const ui = new InMemoryUI();
  let idCounter = 0;
  let tick = 1000;
  const guard = createGuard({
    ui,
    idFactory: () => `id-${++idCounter}`,
    now: () => ++tick,
  });

  let count = 0;
  const calls = { setCount: 0, boom: 0 };

  guard.registerTransactionalTool({
    name: 'set_count',
    description: 'Sets the counter to the given value.',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'New counter value' } },
      required: ['count'],
    },
    preview: (input) => ({ summary: `count → ${String(input.count)}`, diff: { from: count, to: input.count } }),
    execute: (input) => {
      calls.setCount += 1;
      count = input.count as number;
      return { count };
    },
    snapshot: () => count,
    restore: (s) => {
      count = s as number;
    },
  });

  guard.registerTransactionalTool({
    name: 'boom',
    description: 'Always fails during execute.',
    execute: () => {
      calls.boom += 1;
      throw new Error('boom');
    },
    snapshot: () => count,
    restore: () => {},
  });

  guard.registerSafeTool({
    name: 'get_count',
    description: 'Reads the counter.',
    execute: () => ({ count }),
  });

  const propose = (tool: string, input: Record<string, unknown>): string => {
    const p = guard.dispatch(tool, input) as Promise<unknown>;
    p.catch(() => {}); // outcomes are observed via guard.getTransaction / dispatched promise
    return ui.lastTransactionId();
  };

  return {
    guard,
    ui,
    getCount: () => count,
    setCount: (v: number) => {
      count = v;
    },
    calls,
    propose,
  };
}
