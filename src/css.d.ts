declare module '*.css';
/* Vite's ?raw suffix: lets the contrast test read the real stylesheet without
   pulling node:fs (and @types/node) into a browser-only project. */
declare module '*.css?raw' {
  const css: string;
  export default css;
}
