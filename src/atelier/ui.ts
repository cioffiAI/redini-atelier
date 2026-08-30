import type { AtelierStore, FlyerDesign } from './store';
import { templates } from './templates';

/**
 * Atelier DOM rendering: flyer canvas (+ staged ghost preview), template gallery,
 * variants. Subscribes to the store; exposes setGhost() so proposals become
 * visible on the canvas BEFORE they happen.
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

  function paintFlyer(target: HTMLElement, d: FlyerDesign): void {
    target.innerHTML = '';
    target.style.background = d.background;
    target.style.color = d.textColor;
    target.style.fontFamily = d.fontFamily;

    const logo = document.createElement('div');
    logo.className = 'logo-badge';
    logo.textContent = '★';
    logo.style.left = `${d.logo.x}px`;
    logo.style.top = `${d.logo.y}px`;
    logo.style.width = `${d.logo.size}px`;
    logo.style.height = `${d.logo.size}px`;
    logo.style.fontSize = `${Math.round(d.logo.size * 0.5)}px`;
    logo.style.color = d.textColor;
    target.appendChild(logo);

    const box = document.createElement('div');
    box.className = 'flyer-text';
    const h2 = document.createElement('h2');
    h2.textContent = d.title;
    const p1 = document.createElement('p');
    p1.textContent = d.subtitle;
    const p2 = document.createElement('p');
    p2.className = 'flyer-date';
    p2.textContent = d.dateLine;
    box.append(h2, p1, p2);
    target.appendChild(box);
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
        li.innerHTML = `<strong>${v.name}</strong><span>variant ${v.n} · click to view</span>`;
        li.addEventListener('click', () => store.selectVariant(v.id));
        variantsEl.appendChild(li);
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
