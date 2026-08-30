import './styles.css';
import { createGuard } from './redini/index';
import { createDomPanel, humanizeError } from './redini/ui/dom-panel';
import type {
  AuditEntry,
  ChangeSetReceipt,
  RedoEvent,
  UIAdapter,
  UndoEvent,
} from './redini/index';
import type { FlyerDesign } from './atelier/store';
import { AtelierStore, CANVAS_H, CANVAS_W, FONT_OPTIONS } from './atelier/store';
import { registerAtelierTools } from './atelier/tools';
import { initAtelierUI } from './atelier/ui';
import { templates } from './atelier/templates';

const statusEl = document.getElementById('webmcp-status')!;
const activityEl = document.getElementById('activity-log')!;
const devLogEl = document.getElementById('dev-log')!;
const canvasStatusEl = document.getElementById('canvas-status')!;
const ghostBadgeEl = document.getElementById('ghost-badge')!;

/** Long intents are truncated sensibly for the badge/status line (~40 chars). */
function shortIntent(intent: string): string {
  const MAX = 40;
  if (intent.length <= MAX) return intent;
  return `${intent.slice(0, MAX - 1).trimEnd()}…`;
}

/** The ghost badge always names the ChangeSet that OWNS the current preview. */
function setGhostBadge(intent: string): void {
  ghostBadgeEl.textContent = `PREVIEW — not applied yet · ${shortIntent(intent)}`;
}

/** User-facing activity: human words only, no tool names / ids / JSON. */
function logActivity(text: string): void {
  const li = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'activity-time';
  time.textContent = new Date().toLocaleTimeString();
  const body = document.createElement('span');
  body.className = 'activity-body';
  body.textContent = text;
  li.append(time, body);
  activityEl.prepend(li);
}

/** Raw/diagnostic lines (ids, tool names, JSON) — collapsible developer details only. */
function logDev(text: string): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  devLogEl.prepend(li);
}

function setCanvasStatus(text: string, ok = false): void {
  canvasStatusEl.textContent = text;
  canvasStatusEl.classList.toggle('ok', ok);
}

const params = new URLSearchParams(window.location.search);
// Demo mode: ?clean=1 (any value other than '0') hides human-only hints, so
// agent-side mutation happens only through the WebMCP design_update tool path.
const clean = params.has('clean') && params.get('clean') !== '0';
const debug = params.has('debug') && params.get('debug') !== '0';

if (clean) {
  document.querySelectorAll('.human-hint').forEach((el) => el.remove());
}

const store = new AtelierStore();
let atelierUi: { setGhost: (g: FlyerDesign | null) => void } | null = null;
/** Which ChangeSet painted the ghost — only IT may clear it (FIX D). */
let ghostOwner: string | null = null;
/**
 * Cache of the last rendered ghost per FRESH pending ChangeSet. The ghost is
 * a SINGLE slot: when the current owner reaches a terminal status without
 * mutating the world (decline/cancel), the newest fresh proposal's cached
 * preview is promoted back into the slot instead of vanishing.
 */
const previewCache = new Map<string, FlyerDesign | null>();

function setGhost(ghost: FlyerDesign | null): void {
  atelierUi?.setGhost(ghost);
}

/**
 * Paint the single-slot ghost and the preview-wide status lines for `cs`.
 * MAJOR 1: the badge always names the ChangeSet that OWNS the current preview;
 * MAJOR 2: the canvas status reflects the preview state, driven by the same
 * real event (intent named when short).
 */
function paintGhost(cs: { intent: string }, ghost: FlyerDesign | null): void {
  setGhost(ghost);
  if (ghost === null) return;
  setGhostBadge(cs.intent);
  setCanvasStatus(
    cs.intent.length <= 40 ? `Preview — not applied yet · ${cs.intent}` : 'Preview — not applied yet',
  );
}

/**
 * Platform-aware shortcut chips: keep the ids/classes stable for e2e — only
 * the displayed label and tooltip adapt (Mac: ⌘Z / ⇧⌘Z, elsewhere Ctrl+Z).
 */
{
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
  if (!isMac) {
    const chips: Array<[string, string, string]> = [
      ['undo-btn', 'Ctrl+Z', 'Undo (Ctrl+Z)'],
      ['redo-btn', 'Ctrl+Shift+Z', 'Redo (Ctrl+Shift+Z)'],
    ];
    for (const [id, label, title] of chips) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      const kbd = btn.querySelector<HTMLElement>('.kbd');
      if (kbd) kbd.textContent = label;
      btn.title = title;
    }
  }
}

/** Friendly display names for the app's real font stacks. */
const FRIENDLY_FONTS: Record<string, string> = {
  'Georgia, serif': 'Georgia',
  'system-ui, sans-serif': 'System UI',
  'Courier New, monospace': 'Courier New',
};
const friendlyFont = (stack: string): string => FRIENDLY_FONTS[stack] ?? stack.split(',')[0].trim();

/**
 * Redini UI adapter: the DOM panel renders the ChangeSet negotiation cards and
 * the receipts; the canvas ghost shows the proposed result BEFORE it happens.
 * The opHeading/formatValue hints are PRESENTATION ONLY — they translate the
 * technical operation vocabulary into human words so the panel stays
 * application-agnostic (Redini's dom-panel has no Atelier knowledge).
 */
const panel = createDomPanel({
  queueEl: document.getElementById('change-queue')!,
  logEl: activityEl,
  devLogEl,
  undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
  redoBtn: document.getElementById('redo-btn') as HTMLButtonElement,
  // Typed amendment controls: the app's REAL options and canvas bounds.
  editHints: {
    setFont: { value: { options: FONT_OPTIONS } },
    move: { x: { min: 0, max: CANVAS_W }, y: { min: 0, max: CANVAS_H } },
    resize: { size: { min: 16, max: 200 } },
  },
  opHeading: (op) => {
    const p = op.params;
    switch (op.kind) {
      case 'setText': {
        const f = String(p.field ?? '');
        if (f === 'title') return 'Title';
        if (f === 'subtitle') return 'Subtitle';
        if (f === 'dateLine') return 'Date line';
        return f;
      }
      case 'setFill':
        return String(p.target) === 'text' ? 'Text color' : 'Background';
      case 'setFont':
        return 'Font';
      case 'move':
        return 'Logo position';
      case 'resize':
        return 'Logo size';
      default:
        return op.kind;
    }
  },
  formatValue: (op) => {
    const p = op.params;
    switch (op.kind) {
      case 'setText':
        return `"${String(p.value ?? '')}"`;
      case 'setFill':
        return String(p.value ?? '');
      case 'setFont':
        return friendlyFont(String(p.value ?? ''));
      case 'move':
        return `${String(p.x ?? 0)}, ${String(p.y ?? 0)}`;
      case 'resize':
        return `${String(p.size ?? 0)}px`;
      default:
        return '';
    }
  },
});

const ui: UIAdapter & { bind?: (g: ReturnType<typeof createGuard>) => void } = {
  onChangesetUpdated(cs, preview) {
    panel.onChangesetUpdated(cs, preview);
    const ghost = (preview?.diff as { appliedPreview?: FlyerDesign } | undefined)?.appliedPreview ?? null;
    let promoted = false;
    if (cs.status === 'proposed' || cs.status === 'reviewing') {
      if (!cs.isStale) {
        // Fresh proposal: it owns the single slot (last-emitter-wins) and its
        // rendered ghost is cached so a later promotion can restore it.
        previewCache.set(cs.id, ghost);
        ghostOwner = cs.id;
        paintGhost(cs, ghost);
      } else {
        // A stale proposal's preview is misleading: the canvas moved since it
        // was staged — drop it from the cache and clear the slot if it owned it.
        previewCache.delete(cs.id);
        if (ghostOwner === cs.id) {
          ghostOwner = null;
          setGhost(null);
          setCanvasStatus('Proposal expired — the canvas moved while this proposal was open.');
        }
      }
    } else {
      previewCache.delete(cs.id);
      if (ghostOwner === cs.id) {
        // The ChangeSet that painted the ghost reached a terminal status →
        // clear the slot, then PROMOTE: the newest fresh pending proposal with
        // a cached preview takes over. Decline/cancel leave the world
        // untouched, so the previous owner's preview is still valid and
        // returns; commit/undo/redo stale EVERY pending proposal (nothing
        // qualifies) and the sweep's stale updates below keep the slot cleared.
        ghostOwner = null;
        setGhost(null);
        // `guard` is declared later in this module (TDZ-safe: no UI event can
        // fire during the createGuard construction below, so this handler only
        // ever runs after `guard` is assigned).
        const successor = [...guard.getChangeSets()]
          .reverse()
          .find(
            (c) =>
              (c.status === 'proposed' || c.status === 'reviewing') &&
              !c.isStale &&
              previewCache.get(c.id) != null,
          );
        if (successor) {
          ghostOwner = successor.id;
          paintGhost(successor, previewCache.get(successor.id) ?? null);
          promoted = true;
        }
      }
    }
    // The CANVAS area communicates the last decision too (a small status line
    // under the poster, driven by the real status — never decorative text). A
    // promotion restored another live preview — its preview line already won.
    if (!promoted) {
      if (cs.status === 'declined') setCanvasStatus('Declined — nothing was applied.');
      else if (cs.status === 'cancelled') setCanvasStatus('Cancelled — nothing was applied.');
      else if (cs.status === 'stale') setCanvasStatus('Proposal expired — nothing was applied.');
      else if (cs.status === 'failed') setCanvasStatus("A change couldn't be applied — nothing was committed.");
      else if (cs.status === 'undo_failed') setCanvasStatus('Undo failed partway — you can try again.');
    }
  },
  onReceipt(receipt: ChangeSetReceipt): void {
    panel.onReceipt(receipt);
    setCanvasStatus('Committed', true);
  },
  onUndo(ev: UndoEvent): void {
    panel.onUndo(ev);
    ghostOwner = null;
    setGhost(null);
    setCanvasStatus('Undone', true);
  },
  onRedo(ev: RedoEvent): void {
    panel.onRedo(ev);
    ghostOwner = null;
    setGhost(null);
    setCanvasStatus('Redone', true);
  },
  onAudit(entry: AuditEntry): void {
    panel.onAudit(entry);
  },
  bind(g) {
    panel.bind(g);
  },
};

// document.modelContext is available synchronously: create the guard with it
// right away, so every registration lands in the live model context exactly once.
const mc = document.modelContext;
const guard = createGuard({ ui, modelContext: mc ?? null });
// Console access ONLY for debugging: ?debug=1 (the e2e drives the REAL WebMCP
// executeTool path and must not depend on this handle).
if (debug) {
  (window as unknown as { __guard: unknown }).__guard = guard;
}
registerAtelierTools(guard, store);

// Editor-style human keybindings. Undo/redo are HUMAN-side only — they are
// NOT WebMCP tools and never touch the agent tool surface.
window.addEventListener('keydown', (e: KeyboardEvent) => {
  // Never hijack text-editing undo (inputs, textareas, contenteditable).
  const t = e.target;
  if (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  ) {
    return;
  }
  if (!(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();
  const wantUndo = key === 'z' && !e.shiftKey;
  const wantRedo = (key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey);
  if (!wantUndo && !wantRedo) return;
  e.preventDefault();
  const p = wantUndo ? guard.undo() : guard.redo();
  p.catch((err: unknown) => {
    // The keyboard errors surface in the SAME history error slot the Undo/Redo
    // buttons use (panel.renderHistoryError) plus the human activity line and
    // the developer details.
    panel.renderHistoryError(err);
    logActivity(humanizeError(err));
    logDev(err instanceof Error ? err.message : String(err));
  });
});

atelierUi = initAtelierUI(store, (templateId) => {
  // Human direct action: even this flows through a ChangeSet (dispatch +
  // immediate commit), so the audit trail records everything and pending agent
  // ChangeSets correctly go stale. The actor flag keeps provenance honest:
  // a human click is staged by the human, never "Agent proposed".
  const t = templates.find((x) => x.id === templateId);
  if (!t) return;
  const intent = `Template "${t.name}"`;
  const p = guard.dispatch(
    'design_update',
    {
      intent,
      operations: [
        { kind: 'setFill', params: { target: 'background', value: t.design.background } },
        { kind: 'setFill', params: { target: 'text', value: t.design.color } },
        { kind: 'setFont', params: { value: t.design.fontFamily } },
      ],
    },
    undefined,
    { actor: 'human' },
  ) as Promise<unknown>;
  // MAJOR 3: if dispatch rejects (validation), there is NO ChangeSet to commit —
  // never guess with `.at(-1)`. Locate the staged ChangeSet deterministically:
  // the most recent one with THIS intent that is still pending.
  p.then((o) => logDev(`human action: ${JSON.stringify(o)}`)).catch((e: unknown) =>
    logDev(`[atelier] template dispatch failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  const cs = [...guard.getChangeSets()]
    .reverse()
    .find((c) => c.intent === intent && (c.status === 'proposed' || c.status === 'reviewing'));
  if (!cs) return;
  guard.commitChangeSet(cs.id).catch((e: unknown) =>
    logDev(`[atelier] template commit failed: ${e instanceof Error ? e.message : String(e)}`),
  );
});

void (async (): Promise<void> => {
  if (!mc) {
    statusEl.textContent = 'WebMCP not available in this browser';
    statusEl.classList.add('ko');
    return;
  }

  statusEl.textContent = 'WebMCP available';
  statusEl.classList.add('ok');

  // Diagnostics: full registered-tool count, visible without devtools.
  await new Promise((r) => setTimeout(r, 200));
  const registered = await mc.getTools().catch(() => [] as { name: string }[]);
  statusEl.textContent = `WebMCP available · ${registered.length} tools`;
  logDev(`tools registered: ${registered.map((t) => t.name).join(', ') || 'NONE'}`);
})();
