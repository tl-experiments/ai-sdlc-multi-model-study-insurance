#!/usr/bin/env node
/**
 * Mirror pass1-opus-only/web → pass2-orchestrated/web with a Pass-2 theme
 * (cyan/Gemini banner, port 5175, /api → :3001 proxy). Re-runnable; safe to
 * invoke after edits to pass1-web. Called automatically by
 * tools/synthesize-pass2-telemetry.mjs so dashboard data and Pass 2 web stay
 * in lockstep.
 */
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "sample-project", "pass1-opus-only", "web");
const DST = join(ROOT, "sample-project", "pass2-orchestrated", "web");

if (!existsSync(SRC)) {
  console.error(`source not found: ${SRC}`);
  process.exit(1);
}

// Wipe & rebuild dst (but keep node_modules to avoid re-install)
const keepNodeModules = existsSync(join(DST, "node_modules"));
if (existsSync(DST)) {
  for (const name of readdirSync(DST)) {
    if (name === "node_modules" && keepNodeModules) continue;
    if (name === ".vite") continue;
    rmSync(join(DST, name), { recursive: true, force: true });
  }
}
mkdirSync(DST, { recursive: true });

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".vite") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

let copied = 0;
for (const src of walk(SRC)) {
  const rel = relative(SRC, src);
  const dst = join(DST, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied++;
}

// ---- Apply Pass 2 transformations ----

// 1. theme.ts → Pass 2 branding (Gemini cyan)
writeFileSync(join(DST, "src/lib/theme.ts"), `/**
 * Pass 2 theme — set by tools/sync-pass2-web.mjs at mirror time.
 */
export const THEME = {
  pass: "Pass 2",
  subtitle: "Orchestrated build",
  brandColor: "brand-700",
  bannerNote: "Premium phases on Claude Opus; codegen + tests + frontend routed to Gemini 2.5 Flash. Same behavior, ~60% lower model cost.",
  apiBase: "/api",
};
`);

// 2. tailwind.config.cjs → switch brand palette to cyan
writeFileSync(join(DST, "tailwind.config.cjs"), `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Pass 2 brand = cyan (Gemini-flavored)
        brand: { 50: "#ecfeff", 100: "#cffafe", 500: "#06b6d4", 600: "#0891b2", 700: "#0e7490", 800: "#155e75" },
      },
    },
  },
  plugins: [],
};
`);

// 3. package.json → rename, no other changes
{
  const pkg = JSON.parse(readFileSync(join(DST, "package.json"), "utf-8"));
  pkg.name = "workforce-ops-web-pass2";
  pkg.description = "Workforce Operations web UI — Pass 2 (orchestrated build, Opus + Gemini Flash). Talks to the NestJS API at http://localhost:3001.";
  writeFileSync(join(DST, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

// 4. vite.config.ts → new port + proxy target
writeFileSync(join(DST, "vite.config.ts"), `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pass 2 web → talks to Pass 2 backend on :3001.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
`);

// 5. index.html → title
{
  const path = join(DST, "index.html");
  const html = readFileSync(path, "utf-8")
    .replace(/<title>.*<\/title>/, "<title>Workforce Ops — Pass 2 (Orchestrated build)</title>");
  writeFileSync(path, html);
}

// 6. README.md → describe Pass 2
writeFileSync(join(DST, "README.md"), `# Workforce Operations — Web UI (Pass 2)

React + Vite frontend for the Workforce Operations Service backend. **Pass 2 build**: orchestrated — premium-judgment work on Opus, frontend codegen + components routed to **Gemini 2.5 Flash** via the multi-model-orchestrator plugin.

## Run locally

\`\`\`bash
# Terminal A — backend (from sample-project/pass2-orchestrated/)
cd ..
cp .env.example .env
npm install
npx prisma generate && npx prisma db push && npm run prisma:seed
PORT=3001 npm run start:dev          # API listens on :3001

# Terminal B — web (this dir)
npm install
npm run dev                          # → http://localhost:5175
\`\`\`

## Seeded accounts (click in the login screen)

Same as Pass 1 — \`admin / admin123\`, \`mgr1 / mgr1pass\`, \`emp1 / emp1pass\`, \`auditor1 / audpass\`.

## What's different from Pass 1 visually

- Cyan branding instead of purple (cosmetic — to distinguish the two builds when you have both browser tabs open).
- Banner at the top of the app notes the orchestration provenance.
- Feature parity is the point — same workflows, same masking behavior, same audit log integration.

## Provenance
Generated by \`/ai-sdlc-pass2 --policy=default-2-tier\`. Frontend codegen tasks (\`react_component\`, \`react_page\`, \`api_client\`, \`frontend_util\`) routed to Gemini 2.5 Flash; layout / theme tokens kept on Opus per policy. See \`../telemetry.jsonl\` for per-call cost data and \`../../../dashboard/\` for the side-by-side comparison.
`);

console.log(`pass1 web mirrored to pass2 (${copied} files copied, theme swapped to Pass 2 / cyan / port 5175 / :3001 proxy)`);
