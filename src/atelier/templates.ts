/**
 * Atelier — mock template catalog.
 * Kept deliberately small: 4 templates, each a set of design values.
 */
export interface FlyerTemplate {
  id: string;
  name: string;
  styleTags: string[];
  design: {
    background: string;
    color: string;
    fontFamily: 'Georgia, serif' | 'system-ui, sans-serif' | 'Courier New, monospace';
  };
}

export const templates: FlyerTemplate[] = [
  {
    id: 'spring-market',
    name: 'Spring Market',
    styleTags: ['spring', 'light', 'white background', 'floral'],
    design: { background: '#fffdf8', color: '#3f6d3a', fontFamily: 'Georgia, serif' },
  },
  {
    id: 'yard-sale',
    name: 'Yard Sale Classic',
    styleTags: ['casual', 'bold', 'retro'],
    design: { background: '#fdf6e3', color: '#8a4b08', fontFamily: 'Courier New, monospace' },
  },
  {
    id: 'modern-minimal',
    name: 'Modern Minimal',
    styleTags: ['minimal', 'clean', 'monochrome'],
    design: { background: '#ffffff', color: '#111111', fontFamily: 'system-ui, sans-serif' },
  },
  {
    id: 'evening-gala',
    name: 'Evening Gala',
    styleTags: ['elegant', 'dark', 'evening', 'gold'],
    design: { background: '#141420', color: '#e8c46a', fontFamily: 'Georgia, serif' },
  },
];
