/**
 * Atelier domain store v2 — pure logic, no DOM.
 *
 * The mutation vocabulary is intentionally limited and every mutation has an
 * exact inverse: setText, setFill, setFont, move, resize. That is what makes
 * Redini's undo deterministic instead of snapshot-based. EVERY mutation bumps
 * `version` (the explicit stale guard) — there is no mutation without a bump.
 */

export interface LogoState {
  x: number;
  y: number;
  size: number;
}

export interface FlyerDesign {
  templateId: string | null;
  title: string;
  subtitle: string;
  dateLine: string;
  background: string;
  textColor: string;
  fontFamily: string;
  logo: LogoState;
}

export type TextField = 'title' | 'subtitle' | 'dateLine';
export type FillTarget = 'background' | 'text';

export type StoreEventType = 'design';

export type OpInput = { kind: string; params: Record<string, unknown> };

export const FONT_OPTIONS = ['Georgia, serif', 'system-ui, sans-serif', 'Courier New, monospace'];
export const CANVAS_W = 640;
export const CANVAS_H = 400;

const DEFAULT_DESIGN: FlyerDesign = {
  templateId: 'spring-market',
  title: 'Spring Market on Main Street',
  subtitle: 'Local florists, bakers and makers — one day only',
  dateLine: 'May 9th · 10:00–18:00 · Main Street Plaza',
  background: '#fffdf8',
  textColor: '#3f6d3a',
  fontFamily: 'Georgia, serif',
  logo: { x: 500, y: 40, size: 72 },
};

export class AtelierStore {
  design: FlyerDesign = structuredClone(DEFAULT_DESIGN);
  /** Bumped by EVERY mutation — feeds Redini's explicit stale guard. */
  version = 0;

  private listeners = new Set<(type: StoreEventType) => void>();

  onChange(fn: (type: StoreEventType) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: StoreEventType): void {
    this.listeners.forEach((fn) => fn(type));
  }

  private bump(): void {
    this.version += 1;
  }

  // ---------- mutation vocabulary (each has an exact inverse, each bumps) ----------

  setText(field: TextField, value: string): void {
    if (!['title', 'subtitle', 'dateLine'].includes(field)) {
      throw new Error(`unknown text field "${field}"`);
    }
    this.design[field] = value;
    this.bump();
    this.emit('design');
  }

  setFill(target: FillTarget, value: string): void {
    if (target === 'background') this.design.background = value;
    else if (target === 'text') this.design.textColor = value;
    else throw new Error(`unknown fill target "${target}"`);
    this.bump();
    this.emit('design');
  }

  setFont(value: string): void {
    this.design.fontFamily = value;
    this.bump();
    this.emit('design');
  }

  moveLogo(x: number, y: number): void {
    this.design.logo = { ...this.design.logo, x, y };
    this.bump();
    this.emit('design');
  }

  resizeLogo(size: number): void {
    this.design.logo = { ...this.design.logo, size };
    this.bump();
    this.emit('design');
  }

  // ---------- preview (no mutation) ----------

  /** Applies a subset of operations to a throw-away copy: the ghost. */
  simulate(ops: OpInput[]): FlyerDesign {
    const d = structuredClone(this.design);
    for (const op of ops) {
      const p = op.params;
      switch (op.kind) {
        case 'setText':
          if (typeof p.field === 'string' && typeof p.value === 'string' && ['title', 'subtitle', 'dateLine'].includes(p.field)) {
            d[p.field as TextField] = p.value;
          }
          break;
        case 'setFill':
          if (typeof p.value === 'string') {
            if (p.target === 'background') d.background = p.value;
            if (p.target === 'text') d.textColor = p.value;
          }
          break;
        case 'setFont':
          if (typeof p.value === 'string') d.fontFamily = p.value;
          break;
        case 'move':
          if (typeof p.x === 'number' && typeof p.y === 'number') d.logo = { ...d.logo, x: p.x, y: p.y };
          break;
        case 'resize':
          if (typeof p.size === 'number') d.logo = { ...d.logo, size: p.size };
          break;
        default:
          break;
      }
    }
    return d;
  }
}
