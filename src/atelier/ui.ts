import type { AtelierStore, FlyerDesign } from './store';
import { CANVAS_W } from './store';
import { templates } from './templates';

/**
 * Logical canvas px → container-query units. Operations keep speaking in the
 * 640x400 coordinate space (store bounds, amendment min/max, receipts); only
 * the RENDERING is proportional, so the poster scales as one piece on narrow
 * viewports instead of clipping the logo off its right edge.
 *
 * `top` divides by CANVAS_W too, and that is not a typo: .flyer carries
 * aspect-ratio 640/400, so one cqw is worth the same number of logical px
 * vertically as horizontally.
 */
const cq = (v: number): string => `${(v / CANVAS_W) * 100}cqw`;

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
    logo.style.left = cq(d.logo.x);
    logo.style.top = cq(d.logo.y);
    logo.style.width = cq(d.logo.size);
    logo.style.height = cq(d.logo.size);
    logo.style.fontSize = cq(d.logo.size * 0.5);
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

  /**
   * The gallery is static, so it is built ONCE, outside the store subscription.
   * Rebuilding it on every design change used to blow away the focused button:
   * a commit landing while someone was tabbing through the templates dropped
   * focus back to <body>.
   */
  function renderTemplates(): void {
    for (const t of templates) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const strong = document.createElement('strong');
      strong.textContent = t.name;
      const span = document.createElement('span');
      span.textContent = t.styleTags.join(' · ');
      btn.append(strong, span);
      btn.addEventListener('click', () => onPickTemplate(t.id));
      li.appendChild(btn);
      tplListEl.appendChild(li);
    }
  }

  function render(): void {
    paintFlyer(flyerEl, store.design);
  }

  store.onChange(render);
  renderTemplates();
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
