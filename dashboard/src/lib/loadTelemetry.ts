import type {
  TelemetryEvent, Manifest, Policy,
  StudiesConfig, StudyData,
} from "./types";
import { parse as parseYaml } from "yaml";

async function fetchJsonl<T>(path: string): Promise<T[]> {
  const res = await fetch(path);
  if (!res.ok) return [];
  const txt = await res.text();
  return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}
async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json();
}
async function fetchText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) return "";
  return res.text();
}

export interface LoadedData {
  studiesConfig: StudiesConfig;
  studies: StudyData[];
  studyById: Record<string, StudyData>;
  policies: Record<string, Policy>;
}

export async function loadAll(): Promise<LoadedData> {
  // New shape: top-level studies.json describing N case studies
  const studiesConfig: StudiesConfig = await fetchJson("/data/studies.json");

  const studies: StudyData[] = await Promise.all(
    studiesConfig.studies.map(async (studyCfg) => {
      const passes = await Promise.all(
        studyCfg.passes.map(async (passCfg) => {
          const [events, manifest] = await Promise.all([
            fetchJsonl<TelemetryEvent>(`/data/studies/${studyCfg.id}/${passCfg.id}/telemetry.jsonl`),
            fetchJson<Manifest>(`/data/studies/${studyCfg.id}/${passCfg.id}/manifest.json`).catch(() => ({} as Manifest)),
          ]);
          return { config: passCfg, events, manifest };
        })
      );
      const passById = Object.fromEntries(passes.map((p) => [p.config.id, p]));
      return { config: studyCfg, passes, passById };
    })
  );
  const studyById = Object.fromEntries(studies.map((s) => [s.config.id, s]));

  const policyNames = [
    "opus-only", "opus-plus-pro", "opus-plus-flash",
    "default-2-tier", "cost-extreme", "enterprise-balanced", "three-tier-example",
    "opus-4-7", "sonnet-4-6", "haiku-4-5",
    "opus-4-7-with-gemini-3-1-pro", "opus-4-7-with-gemini-3-5-flash",
  ];
  const policies: Record<string, Policy> = {};
  await Promise.all(
    policyNames.map(async (n) => {
      const yaml = await fetchText(`/data/policies/${n}.yaml`);
      if (yaml) {
        try { policies[n] = parseYaml(yaml); } catch {}
      }
    })
  );

  return { studiesConfig, studies, studyById, policies };
}

export async function fetchArtifact(studyId: string, passId: string, path: string): Promise<string> {
  const safe = path.replace(/\//g, "__");
  const res = await fetch(`/data/studies/${studyId}/artifacts/${passId}__${safe}`);
  if (!res.ok) return "";
  return res.text();
}
