import { describe, expect, it } from 'vitest';
import CSS from '../src/styles.css?raw';

/**
 * The secondary inks carry the whole small-text layer of the UI (hints, receipt
 * counters, activity timestamps, developer details, skipped badges) at
 * 0.62-0.78rem, across a dozen call sites and half a dozen surface tokens.
 * A single hex nudge in :root silently drops all of them below WCAG 1.4.3 AA,
 * and nothing else in the suite would notice.
 *
 * So the invariant is asserted where it lives: every ink token against every
 * surface token declared in styles.css, not just the pairings used today.
 */

/** Reads a `--name: #rrggbb;` custom property out of the :root block. */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  if (!m) throw new Error(`token --${name} not found in styles.css`);
  return m[1].toLowerCase();
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every ground the inks can land on. Literals are the hard-coded card/chip
// backgrounds that have no token of their own.
const GROUNDS: Array<[string, string]> = [
  ['--bg', token('bg')],
  ['--surface', token('surface')],
  ['--surface-warm', token('surface-warm')],
  ['--surface-soft', token('surface-soft')],
  ['--accent-soft', token('accent-soft')],
  ['--ok-soft', token('ok-soft')],
  ['--warn-soft', token('warn-soft')],
  ['--danger-soft', token('danger-soft')],
  ['tx-proposed card', '#eef4ff'],
];

const INKS: Array<[string, string]> = [
  ['--text', token('text')],
  ['--text-muted', token('text-muted')],
  ['--text-faint', token('text-faint')],
];

describe('small-text contrast (WCAG 1.4.3 AA)', () => {
  for (const [inkName, ink] of INKS) {
    for (const [groundName, ground] of GROUNDS) {
      it(`${inkName} on ${groundName} clears 4.5:1`, () => {
        expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // The inks must stay distinguishable from each other, or the hierarchy the
  // design relies on collapses into one flat gray.
  it('keeps a visible step between the three inks', () => {
    const [t, m, f] = INKS.map(([, hex]) => luminance(hex));
    expect(m).toBeGreaterThan(t);
    expect(f).toBeGreaterThan(m);
  });
});

describe('error code contrast', () => {
  // .err-code is the one diagnostic ink outside the token system, at 0.64rem on
  // --danger-soft: whoever needs to read it is whoever is already struggling.
  it('.err-code clears 4.5:1 on --danger-soft', () => {
    const m = /\.err-code\s*\{[^}]*color:\s*(#[0-9a-fA-F]{6})/.exec(CSS);
    expect(m, '.err-code color not found').not.toBeNull();
    expect(contrast(m![1].toLowerCase(), token('danger-soft'))).toBeGreaterThanOrEqual(4.5);
  });
});
