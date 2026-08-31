import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  // Vitest blanks CSS modules by default, `?raw` included. The contrast test
  // asserts on the REAL stylesheet, so it needs the actual bytes.
  test: { css: true },
});
