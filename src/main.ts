import './styles.css';
import { templates } from './atelier/templates';

/**
 * Day-1 target (SPIKE): prove the WebMCP pipeline end-to-end.
 * - feature-detect document.modelContext
 * - register one real tool (list_templates)
 * - render mock templates in the UI
 */

const statusEl = document.getElementById('webmcp-status')!;
const templateListEl = document.getElementById('template-list')!;

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

  // SPIKE test 1: one real tool, end-to-end.
  await mc.registerTool({
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
}

void bootstrap();
