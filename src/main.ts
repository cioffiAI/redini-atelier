import './styles.css';
import { templates } from './atelier/templates';
import { createGuard } from './redini/index';
import { createDomPanel } from './redini/ui/dom-panel';

/**
 * Day-1 target (SPIKE): prove the WebMCP pipeline end-to-end.
 * - feature-detect document.modelContext
 * - register one real tool (list_templates)
 * - render mock templates in the UI
 */

const statusEl = document.getElementById('webmcp-status')!;
const templateListEl = document.getElementById('template-list')!;

function logEntry(text: string): void {
  const ul = document.getElementById('activity-log')!;
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  ul.prepend(li);
}

function logRegistrationError(err: unknown): void {
  console.error('Tool registration failed:', err);
  logEntry(`REGISTRATION ERROR: ${String(err)}`);
}


function renderTemplates(): void {
  templateListEl.innerHTML = '';
  for (const t of templates) {
    const li = document.createElement('li');
    li.textContent = `${t.name} (${t.styleTags.join(', ')})`;
    templateListEl.appendChild(li);
  }
}

async function bootstrap(): Promise<void> {
  renderTemplates();

  const mc = document.modelContext;
  if (!mc) {
    statusEl.textContent = 'WebMCP not available in this browser';
    statusEl.classList.add('ko');
    return;
  }

  statusEl.textContent = 'WebMCP available';
  statusEl.classList.add('ok');

  // ---- Redini guard: transactional layer over document.modelContext ----
  const guard = createGuard({
    ui: createDomPanel({
      queueEl: document.getElementById('approval-queue')!,
      logEl: document.getElementById('activity-log')!,
      undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
    }),
    modelContext: mc,
  });
  (window as unknown as { __guard: unknown }).__guard = guard; // console access for testing

  // Safe tool (read-only): executes immediately.
  guard.registerSafeTool({
    name: 'list_templates',
    description:
      'Lists the available flyer templates. Returns id, name and style tags for each template. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          description: 'Optional style tag to filter templates by (e.g. "spring", "minimal", "dark").',
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input: Record<string, unknown>) => {
      const style = typeof input.style === 'string' ? input.style.toLowerCase() : undefined;
      const list = style
        ? templates.filter((t) => t.styleTags.some((tag) => tag.includes(style)))
        : templates;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              templates: list.map((t) => ({ id: t.id, name: t.name, styleTags: t.styleTags })),
            }),
          },
        ],
      };
    },
  });

  // ---- Playground fixture (domain-agnostic counter) ----
  let count = 0;
  const counterEl = document.getElementById('counter-value')!;
  const renderCount = (): void => {
    counterEl.textContent = String(count);
  };

  guard.registerTransactionalTool({
    name: 'set_count',
    description:
      'Proposes a new value for the demo counter. The human inspects, edits or commits the proposal — nothing changes until they commit.',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'New counter value' } },
      required: ['count'],
    },
    preview: (input) => ({ summary: `counter → ${String(input.count)}`, diff: { from: count, to: input.count } }),
    execute: (input) => {
      count = input.count as number;
      renderCount();
      return { count };
    },
    snapshot: () => count,
    restore: (s) => {
      count = s as number;
      renderCount();
    },
  });

  const proposeBtn = (id: string, value: number): void => {
    document.getElementById(id)?.addEventListener('click', () => {
      guard
        .dispatch('set_count', { count: value })
        .then((o) => logEntry(`agent outcome: ${JSON.stringify(o)}`))
        .catch((e: unknown) => logEntry(`dispatch error: ${String(e)}`));
    });
  };
  proposeBtn('propose-42', 42);
  proposeBtn('propose-7', 7);
  renderCount();

  // ---- SPIKE TEST 2: tool resolved manually from the console ----
  let slowResolve: (v: unknown) => void = () => {};
  (window as unknown as { resolveSlow: (v: unknown) => void }).resolveSlow = (v) => slowResolve(v);

  void mc
    .registerTool({
      name: 'slow_tool',
      description:
        'Diagnostic tool: it stays pending until the user resolves it from the page (window.resolveSlow). Call it only if the user asks explicitly.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const started = Date.now();
        const result = await new Promise((res) => {
          slowResolve = res;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `slow_tool resolved after ${Math.round((Date.now() - started) / 1000)}s with: ${JSON.stringify(result)}`,
            },
          ],
        };
      },
    })
    .catch(logRegistrationError);

  // ---- SPIKE TESTS 3+4: declarative form with respondWith ----
  const testForm = document.getElementById('test-form') as HTMLFormElement | null;
  testForm?.addEventListener('submit', (e) => {
    const ev = e as SubmitEvent & { agentInvoked?: boolean; respondWith?: (p: Promise<unknown>) => void };
    logEntry(`test-form submit — agentInvoked: ${ev.agentInvoked === true}`);
    e.preventDefault(); // spike: never navigate
    if (ev.agentInvoked) {
      const data = new FormData(testForm);
      ev.respondWith?.(
        Promise.resolve({
          status: 'booked',
          guest: data.get('guest_name'),
          people: data.get('people'),
        }),
      );
      logEntry(`respondWith sent: booked for ${String(data.get('guest_name'))}`);
    }
  });

  // ---- SPIKE TEST 5: dynamic tool registration ----
  let note = '';
  let noteCounter = 0;

  void mc
    .registerTool({
      name: 'add_note',
      description:
        'Adds a note to the page. It also registers a read_note tool the agent can call to read the note back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The note text' } },
        required: ['text'],
      },
      execute: async (input: Record<string, unknown>) => {
        note = String(input.text ?? '');
        noteCounter += 1;
        await mc.registerTool({
          name: `read_note_${noteCounter}`,
          description: `Returns the text of note number ${noteCounter}. Read-only.`,
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
          execute: async () => ({
            content: [{ type: 'text' as const, text: `note ${noteCounter}: ${note}` }],
          }),
        });
        return {
          content: [
            { type: 'text' as const, text: `Note saved. A tool named read_note_${noteCounter} is now available to read it.` },
          ],
        };
      },
    })
    .catch(logRegistrationError);

  // ---- SPIKE TEST 6: unregistration via AbortController ----
  const tempController = new AbortController();

  void mc
    .registerTool(
      {
        name: 'temp_echo',
        description: 'Echoes its input. Temporary tool, used to test unregistration.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', description: 'Text to echo' } },
          required: ['message'],
        },
        execute: async (input: Record<string, unknown>) => ({
          content: [{ type: 'text' as const, text: `echo: ${String(input.message)}` }],
        }),
      },
      { signal: tempController.signal },
    )
    .catch(logRegistrationError);

  void mc
    .registerTool({
      name: 'dispose_temp',
      description: 'Unregisters the temp_echo tool. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        tempController.abort();
        return { content: [{ type: 'text' as const, text: 'temp_echo has been unregistered' }] };
      },
    })
    .catch(logRegistrationError);
}

void bootstrap();
