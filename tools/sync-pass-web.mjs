#!/usr/bin/env node
/**
 * Re-applies per-pass theme + vite config + package metadata to a pass's
 * web/ subdir. Run this AFTER regen has overwritten those files with
 * Pass-1-style copies (Gemini doesn't know about per-pass branding).
 *
 * Usage:
 *   node tools/sync-pass-web.mjs --pass=pass3
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const passId = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
if (!passId) { console.error("usage: sync-pass-web.mjs --pass=<id>"); process.exit(2); }

const cfg = JSON.parse(readFileSync(join(ROOT, "passes.json"), "utf-8"));
const pass = cfg.passes.find((p) => p.id === passId);
if (!pass) { console.error(`pass id '${passId}' not in passes.json`); process.exit(2); }

const PALETTES = {
  violet: { 50: "#f5f3ff", 100: "#ede9fe", 500: "#8b5cf6", 600: "#7c3aed", 700: "#6d28d9", 800: "#5b21b6" },
  blue:   { 50: "#eff6ff", 100: "#dbeafe", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8", 800: "#1e40af" },
  cyan:   { 50: "#ecfeff", 100: "#cffafe", 500: "#06b6d4", 600: "#0891b2", 700: "#0e7490", 800: "#155e75" },
};
const palette = PALETTES[pass.headerColor] ?? PALETTES.violet;

const WEB = join(ROOT, pass.directory, "web");

// 1) theme.ts
writeFileSync(join(WEB, "src/lib/theme.ts"), `/**
 * ${pass.label} theme — applied by tools/sync-pass-web.mjs from passes.json.
 */
export const THEME = {
  pass: ${JSON.stringify(pass.id.replace(/^pass/, "Pass "))},
  subtitle: ${JSON.stringify(pass.shortLabel)},
  brandColor: "brand-700",
  bannerNote: ${JSON.stringify(pass.description)},
  apiBase: "/api",
};
`);

// 2) tailwind palette
writeFileSync(join(WEB, "tailwind.config.cjs"), `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ${pass.label} brand palette (${pass.headerColor})
        brand: ${JSON.stringify(palette)},
      },
    },
  },
  plugins: [],
};
`);

// 3) vite.config.ts (port + proxy)
writeFileSync(join(WEB, "vite.config.ts"), `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ${pass.label} web → talks to its backend on :${pass.apiPort}.
export default defineConfig({
  plugins: [react()],
  server: {
    port: ${pass.webPort},
    proxy: {
      "/api": {
        target: "http://localhost:${pass.apiPort}",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
`);

// 4) package.json — name + description (preserve dependencies)
{
  const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf-8"));
  pkg.name = `workforce-ops-web-${pass.id}`;
  pkg.description = `Workforce Operations web UI — ${pass.label}. Talks to the NestJS API at http://localhost:${pass.apiPort}.`;
  writeFileSync(join(WEB, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

// 5) ALSO patch Layout.tsx if it has the broken `bg-${THEME.brandColor}` template-class JIT bug.
{
  const layoutPath = join(WEB, "src/components/Layout.tsx");
  try {
    let content = readFileSync(layoutPath, "utf-8");
    if (content.includes("bg-${THEME.brandColor}")) {
      content = content.replace(
        /<header className=\{`bg-\$\{THEME\.brandColor\} text-white px-6 py-3 flex items-center gap-6 shadow`\}>/,
        '<header className="bg-brand-700 text-white px-6 py-3 flex items-center gap-6 shadow-md">'
      );
      // Fix the inline className templating in nav links + sign out button
      content = content.replace(
        /\$\{active \? "bg-white\/20" : "hover:bg-white\/10"\}/g,
        '${active ? "bg-white text-brand-800 shadow-sm" : "text-white hover:bg-white/15"}'
      );
      content = content.replace(
        /<button className="btn-ghost text-slate-900"/,
        '<button className="px-3 py-1.5 rounded text-sm font-medium bg-white/15 text-white border border-white/30 hover:bg-white/25 transition"'
      );
      writeFileSync(layoutPath, content);
      console.log(`  patched Layout.tsx JIT classes`);
    }
  } catch {}
}
{
  const loginPath = join(WEB, "src/pages/Login.tsx");
  try {
    let content = readFileSync(loginPath, "utf-8");
    if (content.includes("text-${THEME.brandColor}")) {
      content = content.replace(
        /<div className=\{`text-xs uppercase tracking-wider text-\$\{THEME\.brandColor\} font-semibold`\}>/,
        '<div className="text-xs uppercase tracking-wider text-brand-700 font-semibold">'
      );
      writeFileSync(loginPath, content);
      console.log(`  patched Login.tsx JIT classes`);
    }
  } catch {}
}

console.log(`\n${pass.id} web synced:`);
console.log(`  port:        ${pass.webPort}`);
console.log(`  api proxy:   http://localhost:${pass.apiPort}`);
console.log(`  brand:       ${pass.headerColor}`);
console.log(`  label:       ${pass.label}`);
