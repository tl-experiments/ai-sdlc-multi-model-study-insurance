/**
 * PostCSS configuration for the Yotsuba Adjuster Workbench.
 *
 * Wires Tailwind CSS (which itself runs as a PostCSS plugin) together with
 * Autoprefixer so the compiled stylesheet picks up vendor prefixes for the
 * browser targets implied by `vite.config.ts` (`target: 'es2022'`).
 *
 * This file is intentionally a `.cjs` module: Vite resolves PostCSS config
 * via Node's CommonJS loader regardless of the surrounding package's
 * `"type": "module"` setting, so using `.cjs` avoids ESM/CJS interop edge
 * cases on Node 20+.
 */

/** @type {import('postcss-load-config').Config} */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};