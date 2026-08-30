import type { AtelierStore, FlyerDesign } from './store';
import { templates } from './templates';

/**
 * Atelier DOM rendering: flyer canvas (+ staged ghost preview) and template
 * gallery. Subscribes to the store; exposes setGhost() so proposals become
 * visible on the canvas BEFORE they happen.
 *
 * Safe-DOM invariant: no innerHTML interpolation of dynamic values anywhere —
 * every dynamic string goes through createElement/textContent.
 */
export function initAtelierUI(
  store: AtelierStore,
  onPickTemplate: (templateId: string) => void,
): { setGhost: (ghost: FlyerDesign | null) => void } {
  const flyerEl = document.getElementById('flyer')!;
  const flyerWrapEl = document.getElementById('flyer-wrap')!;
  const ghostEl = document.getElementById('flyer-ghost')!;
  const ghostBadge = document.getElementById('ghost-badge')!;
  const tplListEl = document.getElementById('template-list')!;

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
      const strong = document.createElement('strong');
      strong.textContent = t.name;
      const span = document.createElement('span');
      span.textContent = t.styleTags.join(' · ');
      li.append(strong, span);
      li.addEventListener('click', () => onPickTemplate(t.id));
      tplListEl.appendChild(li);
    }
  }

  store.onChange(() => render());
  render();

  return {
    setGhost(ghost: FlyerDesign | null): void {
      if (!ghost) {
        ghostEl.classList.add('hidden');
        ghostBadge.classList.add('hidden');
        // FIX preview double-render: while no ghost is staged the committed
        // flyer is the ONLY visible canvas block — and fully reachable again
        // for assistive tech.
        flyerWrapEl.classList.remove('previewing');
        flyerEl.removeAttribute('aria-hidden');
        return;
      }
      paintFlyer(ghostEl, ghost);
      ghostEl.classList.remove('hidden');
      ghostBadge.classList.remove('hidden');
      // ONE coherent preview: the committed flyer is hidden (visibility, so the
      // DOM text stays readable for assertions) while the ghost is staged. The
      // a11y pairing mirrors the visibility exactly: DURING a preview the ghost
      // IS the meaningful content (never aria-hidden), and the covered #flyer
      // is removed from the accessibility tree instead.
      flyerWrapEl.classList.add('previewing');
      flyerEl.setAttribute('aria-hidden', 'true');
    },
  };
}
