import type { AtelierStore, FlyerDesign } from './store';
import { templates } from './templates';

/**
 * Atelier DOM rendering: flyer canvas, ghost preview overlay, template gallery,
 * variants and orders. Subscribes to the store; exposes setGhost() for the
 * Redini UI wrapper (proposals become visible on the canvas BEFORE they happen).
 */
export function initAtelierUI(
  store: AtelierStore,
  onPickTemplate: (templateId: string) => void,
): { setGhost: (ghost: FlyerDesign | null) => void } {
  const flyerEl = document.getElementById('flyer')!;
  const ghostEl = document.getElementById('flyer-ghost')!;
  const ghostBadge = document.getElementById('ghost-badge')!;
  const tplListEl = document.getElementById('template-list')!;
  const variantsEl = document.getElementById('variants-list')!;
  const ordersEl = document.getElementById('orders-list')!;

  function paintFlyer(target: HTMLElement, d: FlyerDesign): void {
    target.innerHTML = '';
    target.style.background = d.background;
    target.style.color = d.color;
    target.style.fontFamily = d.fontFamily;
    if (d.clipart !== 'none') {
      const c = document.createElement('div');
      c.className = 'flyer-clipart';
      c.textContent = d.clipart;
      target.appendChild(c);
    }
    const h2 = document.createElement('h2');
    h2.textContent = d.title;
    const p1 = document.createElement('p');
    p1.textContent = d.subtitle;
    const p2 = document.createElement('p');
    p2.className = 'flyer-date';
    p2.textContent = d.dateLine;
    target.append(h2, p1, p2);
  }

  function render(): void {
    paintFlyer(flyerEl, store.design);

    tplListEl.innerHTML = '';
    for (const t of templates) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${t.name}</strong><span>${t.styleTags.join(' · ')}</span>`;
      li.addEventListener('click', () => onPickTemplate(t.id));
      tplListEl.appendChild(li);
    }

    variantsEl.innerHTML = '';
    if (store.variants.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No variants yet';
      variantsEl.appendChild(li);
    } else {
      for (const v of store.variants) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${v.name}</strong><span>variant ${v.n}</span>`;
        li.addEventListener('click', () => store.selectVariant(v.id));
        variantsEl.appendChild(li);
      }
    }

    ordersEl.innerHTML = '';
    if (store.orders.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No orders yet';
      ordersEl.appendChild(li);
    } else {
      for (const o of [...store.orders].reverse()) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${o.id}</strong><span>${o.copies} copies · ${o.pageSize} — ordered by you</span>`;
        ordersEl.appendChild(li);
      }
    }
  }

  store.onChange(() => render());
  render();

  return {
    setGhost(ghost: FlyerDesign | null): void {
      if (!ghost) {
        ghostEl.classList.add('hidden');
        ghostBadge.classList.add('hidden');
        return;
      }
      paintFlyer(ghostEl, ghost);
      ghostEl.classList.remove('hidden');
      ghostBadge.classList.remove('hidden');
    },
  };
}
