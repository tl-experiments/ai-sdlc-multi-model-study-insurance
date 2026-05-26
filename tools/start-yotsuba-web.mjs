#!/usr/bin/env node
/**
 * Spin up the 4 Yotsuba pass frontends as local Vite dev servers on
 * distinct ports so they can be visually compared in browser tabs.
 *
 * Each pass's web/ has its own vite config + package.json. We override
 * the port via Vite's --port CLI flag (which beats whatever the config
 * specifies). Ports are 5174-5177; 5173 stays free for the comparison
 * dashboard if you want to run it alongside.
 *
 * Usage:
 *   node tools/start-yotsuba-web.mjs              # install + start all 4
 *   node tools/start-yotsuba-web.mjs --no-install # skip npm install (faster restart)
 *   node tools/start-yotsuba-web.mjs --stop       # kill all running dev servers
 *
 * Logs go to logs/web-<pass-id>.log.
 * PIDs are tracked in logs/yotsuba-web.pids for clean shutdown.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOGS = join(ROOT, "logs");
const PID_FILE = join(LOGS, "yotsuba-web.pids");

mkdirSync(LOGS, { recursive: true });

const PASSES = [
  { id: "opus-4-7",                        label: "Opus 4.7",            port: 5174, color: "violet" },
  { id: "sonnet-4-6",                      label: "Sonnet 4.6",          port: 5175, color: "blue" },
  { id: "haiku-4-5",                       label: "Haiku 4.5",           port: 5176, color: "amber" },
  { id: "opus-4-7-with-gemini-3-5-flash",  label: "Opus + Gemini Flash", port: 5177, color: "cyan" },
];

const ARG_NO_INSTALL = process.argv.includes("--no-install");
const ARG_STOP       = process.argv.includes("--stop");

if (ARG_STOP) {
  stopAll();
  process.exit(0);
}

// ─── stop helpers ───
function stopAll() {
  if (!existsSync(PID_FILE)) {
    console.log("No yotsuba-web.pids file — nothing to stop.");
    return;
  }
  const pids = readFileSync(PID_FILE, "utf-8").split("\n").filter(Boolean);
  for (const line of pids) {
    const [pid, label] = line.split("\t");
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`  ✓ stopped ${label} (pid ${pid})`);
    } catch (e) {
      console.log(`  · ${label} (pid ${pid}) already gone`);
    }
  }
  writeFileSync(PID_FILE, "");
}

// ─── install helpers ───
function installWithFallback(passDir, label) {
  if (existsSync(join(passDir, "node_modules"))) {
    console.log(`  · ${label}: node_modules present, skipping install`);
    return true;
  }
  console.log(`  ↻ ${label}: npm install (first run)…`);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      execSync("npm install --no-audit --no-fund --no-progress --silent 2>&1", {
        cwd: passDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8",
      });
      console.log(`  ✓ ${label}: installed`);
      return true;
    } catch (e) {
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      const m = out.match(/No matching version found for (@?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)@\S+?\./);
      if (!m) {
        console.log(`  ✗ ${label}: install failed (non-version error):`);
        console.log(out.split("\n").slice(-10).map((l) => "      " + l).join("\n"));
        return false;
      }
      const name = m[1];
      const pkgPath = join(passDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const target = pkg.dependencies?.[name] !== undefined ? "dependencies"
                   : pkg.devDependencies?.[name] !== undefined ? "devDependencies"
                   : null;
      if (!target) {
        console.log(`  ✗ ${label}: hallucinated dep ${name} not in package.json — giving up`);
        return false;
      }
      console.log(`  ↻ ${label}: ${name}@${pkg[target][name]} → ${name}@latest`);
      pkg[target][name] = "latest";
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
  }
  return false;
}

// ─── dev server helpers ───
function startDevServer(passDir, port, label, passId) {
  const logFile = join(LOGS, `web-${passId}.log`);
  const out = openSync(logFile, "w");
  const err = openSync(logFile, "a");
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort", "false", "--host", "127.0.0.1"], {
    cwd: passDir,
    stdio: ["ignore", out, err],
    detached: true,
  });
  child.unref();
  return child.pid;
}

// ─── main ───
console.log("\nYotsuba — local web frontend launcher\n");

const pids = [];
for (const pass of PASSES) {
  const passDir = join(ROOT, "case-studies/yotsuba-claims-platform/passes", pass.id, "web");
  if (!existsSync(passDir)) {
    console.log(`  ✗ ${pass.label}: ${passDir} not found, skipping`);
    continue;
  }

  if (!ARG_NO_INSTALL) {
    const ok = installWithFallback(passDir, pass.label);
    if (!ok) {
      console.log(`  ✗ ${pass.label}: install failed, skipping dev server`);
      continue;
    }
  }

  const pid = startDevServer(passDir, pass.port, pass.label, pass.id);
  pids.push(`${pid}\t${pass.label}`);
  console.log(`  ✓ ${pass.label.padEnd(26)} pid=${pid}  →  http://localhost:${pass.port}`);
}

writeFileSync(PID_FILE, pids.join("\n") + "\n");

console.log("\n  All servers backgrounded. Tail a log to see startup output:");
console.log("    tail -f logs/web-opus-4-7.log");
console.log("\n  Stop all with:");
console.log("    node tools/start-yotsuba-web.mjs --stop");
console.log("\n  Note: backends don't compile (TS errors). UI shells render; clicking anything that hits /api will 502.\n");
