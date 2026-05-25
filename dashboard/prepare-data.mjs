#!/usr/bin/env node
/**
 * Driven by /studies.json at the project root. For each registered case
 * study, walks its passes and copies telemetry.jsonl + manifest.json under
 * dashboard/public/data/studies/<study-id>/<pass-id>/...
 *
 * Also copies all policies and per-pass artifact pairs for the diff viewer.
 * Backwards-compatible: legacy /passes.json still works for the Phase-1 era,
 * but studies.json is now the source of truth.
 */
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_OUT = join(__dirname, "public", "data");

const STUDIES_PATH = join(ROOT, "studies.json");
if (!existsSync(STUDIES_PATH)) {
  console.error(`missing studies.json at ${STUDIES_PATH}`);
  process.exit(2);
}
const studies = JSON.parse(readFileSync(STUDIES_PATH, "utf-8"));

mkdirSync(DATA_OUT, { recursive: true });
mkdirSync(join(DATA_OUT, "policies"), { recursive: true });
mkdirSync(join(DATA_OUT, "studies"), { recursive: true });

// Mirror studies.json so the SPA can fetch it.
copyFileSync(STUDIES_PATH, join(DATA_OUT, "studies.json"));

// Curated artifact files for the side-by-side diff viewer. Listed once;
// each study's prepare step looks up the equivalent path for each pass.
const DIFF_ARTIFACTS_DEFAULT = [
  "src/employees/employees.controller.ts",
  "src/employees/employees.service.ts",
  "src/leave-requests/leave-requests.service.ts",
  "test/employees.e2e.spec.ts",
  "security_review.md",
  "web/src/pages/LeaveRequests.tsx",
];
const DIFF_ARTIFACTS_PER_STUDY = {
  // Phase 1 uses the Workforce Ops file list above (the default).
  "workforce-ops": DIFF_ARTIFACTS_DEFAULT,
  // Phase 2 will use a claims-platform-specific set (filled in once passes land).
  "yotsuba-claims": [
    "src/claims/claims.controller.ts",
    "src/claims/claims.service.ts",
    "src/reserves/reserves.service.ts",
    "test/claims-fnol.e2e.spec.ts",
    "docs/adr/004-claim-status-fsm.md",
    "web/src/pages/ClaimDetail.tsx",
  ],
};

let totalStudies = 0, totalPasses = 0, totalArtifacts = 0;

for (const study of studies.studies) {
  const studyDir = join(DATA_OUT, "studies", study.id);
  mkdirSync(studyDir, { recursive: true });

  // Per-pass data
  for (const pass of study.passes) {
    const passOut = join(studyDir, pass.id);
    mkdirSync(passOut, { recursive: true });

    const passSourceDir = join(ROOT, study.passes_root, pass.directory);
    for (const name of ["telemetry.jsonl", "manifest.json"]) {
      const src = join(passSourceDir, name);
      if (!existsSync(src)) { continue; }
      copyFileSync(src, join(passOut, name));
    }
    totalPasses++;
  }

  // Side-by-side artifact files
  const artifactDir = join(studyDir, "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const artifactList = DIFF_ARTIFACTS_PER_STUDY[study.id] ?? DIFF_ARTIFACTS_DEFAULT;
  for (const relPath of artifactList) {
    for (const pass of study.passes) {
      const src = join(ROOT, study.passes_root, pass.directory, relPath);
      if (!existsSync(src)) continue;
      const safe = relPath.replace(/\//g, "__");
      copyFileSync(src, join(artifactDir, `${pass.id}__${safe}`));
      totalArtifacts++;
    }
  }
  writeFileSync(
    join(artifactDir, "_index.json"),
    JSON.stringify({ files: artifactList, passes: study.passes.map((p) => p.id) }, null, 2)
  );

  totalStudies++;
}

// All policies — fetched lazily by the dashboard regardless of study
const POLICIES = join(ROOT, "plugin", "config", "policies");
if (existsSync(POLICIES)) {
  for (const name of readdirSync(POLICIES)) {
    copyFileSync(join(POLICIES, name), join(DATA_OUT, "policies", name));
  }
}

// Back-compat: also write a passes.json that flattens the Phase 1 "workforce-ops"
// study so older dashboard builds keep working without code changes.
const phase1 = studies.studies.find((s) => s.id === "workforce-ops");
if (phase1) {
  const compat = {
    passes: phase1.passes.map((p) => ({
      id: p.id,
      label: p.label,
      shortLabel: p.shortLabel,
      directory: `${phase1.passes_root}/${p.directory}`,
      policy: p.policy,
      headerColor: p.headerColor,
      description: phase1.description,
    })),
    model_substitutions: studies.model_substitutions,
  };
  writeFileSync(join(DATA_OUT, "passes.json"), JSON.stringify(compat, null, 2));
}

console.log(`dashboard data prepared at: ${DATA_OUT}`);
console.log(`  studies:        ${totalStudies}  (${studies.studies.map((s) => s.id).join(", ")})`);
console.log(`  passes copied:  ${totalPasses}`);
console.log(`  artifacts:      ${totalArtifacts} files staged for the diff viewer`);
console.log(`  policies:       ${existsSync(POLICIES) ? readdirSync(POLICIES).length : 0}`);
