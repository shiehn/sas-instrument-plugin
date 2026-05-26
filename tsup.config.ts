import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  // Dual CJS + ESM so the package.json `exports` map resolves for both the
  // host's tsc/jest (require → dist/index.js) and bundlers (import → index.mjs).
  format: ['cjs', 'esm'],
  // Emit declarations so the host's tsc can type `@signalsandsorcery/instrument-generator`.
  dts: true,
  sourcemap: true,
  clean: true,
  // Provided by the host / deduped — never bundled.
  external: ['react', 'react-dom', '@signalsandsorcery/plugin-sdk'],
  jsx: 'automatic',
});
