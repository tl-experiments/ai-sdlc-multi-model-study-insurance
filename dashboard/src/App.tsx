import React, { useEffect, useState } from "react";
import {
  BrowserRouter, Routes, Route, Link, useParams, Navigate, useLocation,
} from "react-router-dom";
import { loadAll, type LoadedData } from "./lib/loadTelemetry";
import { ExecutiveView } from "./views/Executive";
import { EngineeringView } from "./views/Engineering";
import { PolicyBuilder } from "./views/PolicyBuilder";
import { CaseStudyLanding } from "./views/CaseStudyLanding";
import { TilichoHeader } from "./components/TilichoHeader";

export function App() {
  const [data, setData] = useState<LoadedData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadAll().then(setData).catch((e) => setErr(e?.message ?? String(e)));
  }, []);

  if (err) return <div className="p-12 text-red-600">Failed to load: {err}</div>;
  if (!data) return <div className="p-12 text-slate-500">Loading studies…</div>;

  const anySubstituted = Object.keys(data.studiesConfig.model_substitutions ?? {}).length > 0;

  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <TilichoHeader />
        <Routes>
          <Route path="/" element={<LandingShell data={data} />} />
          <Route path="/builder" element={<BuilderShell data={data} />} />
          <Route path="/:studyId" element={<StudyRoot data={data} />} />
          <Route path="/:studyId/:view" element={<StudyShell data={data} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <footer className="px-8 py-4 text-center text-xs text-slate-400 space-y-1">
          <div>Independent Study by Tilicho Labs · multi-model-orchestrator</div>
          {anySubstituted && (
            <div className="text-amber-700 bg-amber-50 inline-block px-2 py-0.5 rounded">
              Model substitutions in effect:{" "}
              {Object.entries(data.studiesConfig.model_substitutions ?? {})
                .filter(([k]) => !k.startsWith("_"))
                .map(([req, sub]: any) => `${req} → ${sub.actual_api_model}`)
                .join(", ")}
            </div>
          )}
        </footer>
      </div>
    </BrowserRouter>
  );
}

// ──────────────── Landing (portfolio of studies) ────────────────
function LandingShell({ data }: { data: LoadedData }) {
  return (
    <>
      <NavBar data={data} />
      <main className="px-8 py-8 max-w-7xl mx-auto">
        <CaseStudyLanding data={data} />
      </main>
    </>
  );
}

// ──────────────── Per-study root (redirects to default tab) ─────
function StudyRoot({ data }: { data: LoadedData }) {
  const { studyId } = useParams();
  if (!studyId || !data.studyById[studyId]) return <Navigate to="/" replace />;
  return <Navigate to={`/${studyId}/exec`} replace />;
}

// ──────────────── Per-study shell (exec / eng inside a study) ───
function StudyShell({ data }: { data: LoadedData }) {
  const { studyId, view } = useParams();
  if (!studyId || !data.studyById[studyId]) return <Navigate to="/" replace />;
  const study = data.studyById[studyId];
  return (
    <>
      <NavBar data={data} activeStudyId={studyId} activeView={view ?? "exec"} />
      <Breadcrumb studyLabel={study.config.label} />
      <main className="px-8 py-6 max-w-7xl mx-auto">
        {view === "exec" && <ExecutiveView data={data} study={study} />}
        {view === "eng"  && <EngineeringView data={data} study={study} />}
        {view !== "exec" && view !== "eng" && <Navigate to={`/${studyId}/exec`} replace />}
      </main>
    </>
  );
}

// ──────────────── Builder (global, not study-scoped) ────────────
function BuilderShell({ data }: { data: LoadedData }) {
  return (
    <>
      <NavBar data={data} activeView="builder" />
      <main className="px-8 py-6 max-w-7xl mx-auto">
        <PolicyBuilder data={data as any} />
      </main>
    </>
  );
}

// ──────────────── Nav bar ────────────────
function NavBar({
  data, activeStudyId, activeView,
}: { data: LoadedData; activeStudyId?: string; activeView?: string }) {
  const loc = useLocation();
  const onLanding = loc.pathname === "/";
  return (
    <header className="bg-white border-b border-slate-200 px-8 py-3 flex items-center justify-between sticky top-0 z-10 shadow-sm">
      <div className="text-sm text-slate-500">
        {onLanding
          ? <>{data.studies.length} case {data.studies.length === 1 ? "study" : "studies"} · {data.studies.map((s) => s.config.shortLabel).join(" · ")}</>
          : activeStudyId
            ? <Link to="/" className="text-slate-600 hover:text-ink hover:underline">← All studies</Link>
            : <Link to="/" className="text-slate-600 hover:text-ink hover:underline">← All studies</Link>}
      </div>
      <nav className="flex gap-2">
        {activeStudyId && [
          ["exec", "Executive view"],
          ["eng",  "Engineering view"],
        ].map(([key, label]) => (
          <Link
            key={key}
            to={`/${activeStudyId}/${key}`}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeView === key ? "tab-active" : "tab-inactive"}`}
          >{label}</Link>
        ))}
        <Link
          to="/builder"
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeView === "builder" ? "tab-active" : "tab-inactive"}`}
        >Policy builder</Link>
      </nav>
    </header>
  );
}

function Breadcrumb({ studyLabel }: { studyLabel: string }) {
  return (
    <div className="bg-slate-100 px-8 py-1.5 text-xs text-slate-600 border-b border-slate-200">
      <Link to="/" className="hover:underline">Case studies</Link>
      <span className="mx-1.5 text-slate-400">/</span>
      <span className="font-medium text-slate-800">{studyLabel}</span>
    </div>
  );
}
