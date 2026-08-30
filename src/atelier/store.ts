import { templates } from './templates';

/**
 * Atelier domain store — pure logic, no DOM.
 * The UI subscribes via onChange; Redini tools mutate through methods.
 */

export interface FlyerDesign {
  templateId: string | null;
  title: string;
  subtitle: string;
  dateLine: string;
  background: string;
  color: string;
  fontFamily: string;
  clipart: string;
}

export const EDITABLE_FIELDS = [
  'title',
  'subtitle',
  'dateLine',
  'background',
  'color',
  'fontFamily',
  'clipart',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface FlyerDiff {
  changes: Array<{ field: EditableField | 'templateId'; from: unknown; to: unknown }>;
  ghostDesign: FlyerDesign;
}

export interface Variant {
  id: string;
  n: number;
  name: string;
  design: FlyerDesign;
  controller: AbortController;
}

export interface Order {
  id: string;
  copies: number;
  pageSize: string;
  design: FlyerDesign;
}

export interface StoreSnapshot {
  design: FlyerDesign;
  variants: Variant[];
  orders: Order[];
  variantCounter: number;
  orderCounter: number;
}

const DEFAULT_DESIGN: FlyerDesign = {
  templateId: 'spring-market',
  title: 'Spring Market on Main Street',
  subtitle: 'Local florists, bakers and makers — one day only',
  dateLine: 'May 9th · 10:00–18:00 · Main Street Plaza',
  background: '#fffdf8',
  color: '#3f6d3a',
  fontFamily: 'Georgia, serif',
  clipart: '✿',
};

export type StoreEventType = 'design' | 'variants' | 'orders';

export class AtelierStore {
  design: FlyerDesign = structuredClone(DEFAULT_DESIGN);
  variants: Variant[] = [];
  orders: Order[] = [];
  variantCounter = 0;
  orderCounter = 1000;

  private listeners = new Set<(type: StoreEventType) => void>();

  onChange(fn: (type: StoreEventType) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: StoreEventType): void {
    this.listeners.forEach((fn) => fn(type));
  }

  /** Merges a partial edit input onto the current design. Only known string fields. */
  applyEdit(input: Record<string, unknown>): FlyerDesign {
    const ghost = this.ghostDesign(input);
    if (typeof input.templateId === 'string') {
      const t = templates.find((t) => t.id === input.templateId);
      if (t) ghost.templateId = t.id;
    }
    this.design = ghost;
    this.emit('design');
    return structuredClone(this.design);
  }

  applyTemplate(templateId: string): FlyerDesign {
    const t = templates.find((t) => t.id === templateId);
    if (!t) throw new Error(`unknown template "${templateId}"`);
    this.design = {
      ...this.design,
      templateId: t.id,
      background: t.design.background,
      color: t.design.color,
      fontFamily: t.design.fontFamily,
    };
    this.emit('design');
    return structuredClone(this.design);
  }

  /** Field-level diff between the current design and a proposed edit. */
  diffEdit(input: Record<string, unknown>): FlyerDiff['changes'] {
    const changes: FlyerDiff['changes'] = [];
    for (const field of EDITABLE_FIELDS) {
      const to = input[field];
      if (typeof to === 'string' && to !== this.design[field]) {
        changes.push({ field, from: this.design[field], to });
      }
    }
    return changes;
  }

  /** The design as it WOULD be after the proposed edit — rendered as the on-canvas ghost. */
  ghostDesign(input: Record<string, unknown>): FlyerDesign {
    const ghost = structuredClone(this.design);
    for (const field of EDITABLE_FIELDS) {
      const to = input[field];
      if (typeof to === 'string') (ghost as unknown as Record<string, unknown>)[field] = to;
    }
    if (typeof input.templateId === 'string') {
      const t = templates.find((t) => t.id === input.templateId);
      if (t) {
        ghost.templateId = t.id;
        ghost.background = t.design.background;
        ghost.color = t.design.color;
        ghost.fontFamily = t.design.fontFamily;
      }
    }
    return ghost;
  }

  createVariant(name?: string): Variant {
    this.variantCounter += 1;
    const v: Variant = {
      id: `variant-${this.variantCounter}`,
      n: this.variantCounter,
      name: typeof name === 'string' && name.trim() ? name.trim() : `Variant ${this.variantCounter}`,
      design: structuredClone(this.design),
      controller: new AbortController(),
    };
    this.variants.push(v);
    this.emit('variants');
    return v;
  }

  selectVariant(id: string): FlyerDesign | null {
    const v = this.variants.find((v) => v.id === id);
    if (!v) return null;
    this.design = structuredClone(v.design);
    this.emit('design');
    return this.design;
  }

  addOrder(copies: number, pageSize: string): Order {
    this.orderCounter += 1;
    const order: Order = {
      id: `ORD-${this.orderCounter}`,
      copies,
      pageSize,
      design: structuredClone(this.design),
    };
    this.orders.push(order);
    this.emit('orders');
    return order;
  }

  snapshotAll(): StoreSnapshot {
    return {
      design: structuredClone(this.design),
      variants: [...this.variants],
      orders: [...this.orders],
      variantCounter: this.variantCounter,
      orderCounter: this.orderCounter,
    };
  }

  restoreAll(s: StoreSnapshot): void {
    // Abort controllers of variants that disappear with the rollback:
    // their dynamically registered tools get unregistered too.
    const keep = new Set(s.variants.map((v) => v.id));
    for (const v of this.variants) {
      if (!keep.has(v.id)) v.controller.abort();
    }
    this.design = structuredClone(s.design);
    this.variants = [...s.variants];
    this.orders = [...s.orders];
    this.variantCounter = s.variantCounter;
    this.orderCounter = s.orderCounter;
    this.emit('design');
    this.emit('variants');
    this.emit('orders');
  }
}
