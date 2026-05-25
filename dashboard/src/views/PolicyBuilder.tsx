import React, { useEffect, useMemo, useState } from "react";
import type { LoadedData } from "../lib/loadTelemetry";
import type { Policy, PolicyModel } from "../lib/types";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Form + YAML toggle policy editor. Lets you start from any existing policy,
 * mutate via the form, see live YAML, and download (or copy) the result.
 *
 * Schema validation is inline — invalid rules are highlighted and the
 * "Download" button stays disabled while errors exist.
 */
export function PolicyBuilder({ data }: { data: LoadedData }) {
  const [seed, setSeed] = useState<string>("opus-plus-flash");
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [policy, setPolicy] = useState<Policy>(() =>
    JSON.parse(JSON.stringify(data.policies[seed] ?? blankPolicy()))
  );
  const [yamlText, setYamlText] = useState<string>(() => stringifyYaml(policy));
  const [yamlError, setYamlError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "yaml") setYamlText(stringifyYaml(policy));
  }, [policy, mode]);

  // Resetting via seed dropdown
  function loadSeed(name: string) {
    setSeed(name);
    const p = data.policies[name] ?? blankPolicy();
    const fresh = JSON.parse(JSON.stringify(p)) as Policy;
    setPolicy(fresh);
    setYamlText(stringifyYaml(fresh));
    setYamlError(null);
  }
  function applyYaml(text: string) {
    setYamlText(text);
    try {
      const parsed = parseYaml(text) as Policy;
      validatePolicy(parsed);
      setPolicy(parsed);
      setYamlError(null);
    } catch (e: any) {
      setYamlError(e?.message ?? String(e));
    }
  }

  const errors = useMemo(() => collectErrors(policy), [policy]);
  const canExport = errors.length === 0 && !yamlError;

  function download() {
    const blob = new Blob([stringifyYaml(policy)], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${policy.name || "policy"}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function copyToClipboard() {
    await navigator.clipboard.writeText(stringifyYaml(policy));
    alert("Policy YAML copied to clipboard.");
  }

  return (
    <div className="space-y-4">
      {/* Intro — explains what the builder does + the basic flow */}
      <section className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-5 border border-blue-200">
        <div className="flex items-start gap-3">
          <div className="text-2xl shrink-0">🛠️</div>
          <div className="flex-1">
            <h2 className="text-base font-bold text-slate-900">Build a routing policy</h2>
            <p className="text-sm text-slate-700 mt-1 leading-relaxed">
              A policy decides <em>which model</em> handles <em>which kind of work</em>. Each rule matches on
              phase / task_type / module / retry_count and routes to one of the models you register. The
              <strong> first matching rule wins</strong>; if nothing matches, the <strong>default</strong> rule fires.
            </p>
            <ol className="text-sm text-slate-700 mt-2 list-decimal list-inside space-y-0.5">
              <li>Seed from an existing policy or start blank.</li>
              <li>Register your models (id, API name, pricing, auth env var).</li>
              <li>Add rules with matchers and a fallback. Validation runs as you type.</li>
              <li>Export YAML — drop into <code className="bg-white px-1.5 py-0.5 rounded text-xs">plugin/config/policies/</code>.</li>
            </ol>
          </div>
        </div>
      </section>

      {/* Mode + seed bar — separated from export actions */}
      <section className="card flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="label">Seed from</span>
          <select
            value={seed}
            onChange={(e) => loadSeed(e.target.value)}
            className="input !w-auto !py-1.5"
          >
            {Object.keys(data.policies).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={() => loadSeed("__blank__")} className="text-xs text-slate-500 hover:text-slate-700 hover:underline">or blank slate</button>
        </div>
        <div className="ml-auto flex gap-1 rounded-md bg-slate-100 p-1">
          <button onClick={() => setMode("form")} className={`px-3 py-1 rounded text-sm font-medium transition ${mode === "form" ? "bg-white shadow text-ink" : "text-slate-600 hover:text-slate-900"}`}>Form view</button>
          <button onClick={() => setMode("yaml")} className={`px-3 py-1 rounded text-sm font-medium transition ${mode === "yaml" ? "bg-white shadow text-ink" : "text-slate-600 hover:text-slate-900"}`}>YAML view</button>
        </div>
      </section>

      {/* Export action bar — visually separated with emerald accent so it's
          obvious these are commit-style actions, not part of the editor controls */}
      <section className="bg-emerald-50 border-2 border-emerald-200 rounded-xl px-5 py-3 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wider text-emerald-800 font-semibold">Export</div>
          <div className="text-sm text-slate-700">
            {canExport
              ? <>Policy <code className="bg-white px-1.5 py-0.5 rounded text-xs">{policy.name}</code> is valid — ready to ship.</>
              : <>Fix the validation errors above before exporting.</>}
          </div>
        </div>
        <button onClick={download} disabled={!canExport} className={`px-5 py-2 rounded-md text-sm font-bold shadow-sm transition ${canExport ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>↓ Download YAML</button>
        <button onClick={copyToClipboard} disabled={!canExport} className="px-4 py-2 rounded-md text-sm font-medium bg-white border border-emerald-300 hover:bg-emerald-50 text-emerald-800 transition disabled:opacity-50">⧉ Copy YAML</button>
      </section>

      {errors.length > 0 && (
        <section className="card border-rose-200 bg-rose-50">
          <h3 className="font-semibold text-rose-800 mb-2">Validation errors ({errors.length})</h3>
          <ul className="text-sm text-rose-700 space-y-1">
            {errors.map((e, i) => <li key={i}>• {e}</li>)}
          </ul>
        </section>
      )}

      {mode === "form" ? (
        <FormEditor policy={policy} setPolicy={setPolicy} />
      ) : (
        <YamlEditor yamlText={yamlText} yamlError={yamlError} onChange={applyYaml} />
      )}
    </div>
  );
}

// ───────────────────────── form editor ─────────────────────────

function FormEditor({ policy, setPolicy }: { policy: Policy; setPolicy: (p: Policy) => void }) {
  function update(mut: (p: Policy) => void) {
    const clone = JSON.parse(JSON.stringify(policy)) as Policy;
    mut(clone);
    setPolicy(clone);
  }
  return (
    <>
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Policy metadata</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <label className="label">Name</label>
            <input className="input mt-1" value={policy.name} onChange={(e) => update((p) => { p.name = e.target.value; })} />
          </div>
          <div>
            <label className="label">Version</label>
            <input type="number" className="input mt-1" value={policy.version} onChange={(e) => update((p) => { p.version = Number(e.target.value); })} />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Models</h2>
          <button onClick={() => update((p) => { p.models.push(blankModel()); })} className="px-3 py-1 text-sm bg-ink text-white rounded">+ Add model</button>
        </div>
        <div className="space-y-3">
          {policy.models.map((m, i) => (
            <ModelRow
              key={i}
              model={m}
              onChange={(next) => update((p) => { p.models[i] = next; })}
              onDelete={() => update((p) => { p.models.splice(i, 1); })}
            />
          ))}
          {policy.models.length === 0 && <div className="text-slate-500 text-sm">No models defined. Add one above.</div>}
        </div>
      </section>

      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Routing rules (first-match)</h2>
          <div className="flex gap-2">
            <button onClick={() => update((p) => { p.rules.splice(p.rules.findIndex((r: any) => "default" in r), 0, blankRule()); })} className="px-3 py-1 text-sm bg-ink text-white rounded">+ Add rule</button>
            {!policy.rules.some((r: any) => "default" in r) && (
              <button onClick={() => update((p) => { p.rules.push({ default: p.models[0]?.id ?? "opus", reason: "fallback" }); })} className="px-3 py-1 text-sm bg-slate-700 text-white rounded">+ Add fallback</button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          {policy.rules.map((r, i) => (
            <RuleRow
              key={i}
              rule={r}
              models={policy.models}
              index={i}
              onChange={(next) => update((p) => { p.rules[i] = next; })}
              onDelete={() => update((p) => { p.rules.splice(i, 1); })}
              onMoveUp={i > 0 ? () => update((p) => { [p.rules[i - 1], p.rules[i]] = [p.rules[i], p.rules[i - 1]]; }) : undefined}
              onMoveDown={i < policy.rules.length - 1 ? () => update((p) => { [p.rules[i + 1], p.rules[i]] = [p.rules[i], p.rules[i + 1]]; }) : undefined}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function ModelRow({ model, onChange, onDelete }: { model: PolicyModel; onChange: (m: PolicyModel) => void; onDelete: () => void }) {
  function set<K extends keyof PolicyModel>(k: K, v: PolicyModel[K]) { onChange({ ...model, [k]: v }); }
  function setPricing(k: "input" | "input_cached" | "output", v: number) {
    onChange({ ...model, pricing: { ...model.pricing, [k]: v } });
  }
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
      <div className="grid grid-cols-6 gap-2 text-sm">
        <Field label="ID"><input className="input" value={model.id} onChange={(e) => set("id", e.target.value)} /></Field>
        <Field label="Adapter">
          <select className="input" value={model.adapter} onChange={(e) => set("adapter", e.target.value)}>
            <option value="builtin-anthropic">builtin-anthropic</option>
            <option value="mcp:gemini-flash-server">mcp:gemini-flash-server</option>
          </select>
        </Field>
        <Field label="Model name (API)"><input className="input" value={model.model_name} onChange={(e) => set("model_name", e.target.value)} /></Field>
        <Field label="Display name (optional)"><input className="input" value={model.display_name ?? ""} onChange={(e) => set("display_name", e.target.value || undefined)} /></Field>
        <Field label="Env var">
          <input className="input" value={model.auth?.env ?? ""} onChange={(e) => onChange({ ...model, auth: { env: e.target.value || undefined } })} />
        </Field>
        <div className="flex items-end justify-end"><button onClick={onDelete} className="text-rose-600 text-xs hover:underline">Delete</button></div>
        <Field label="Input ($/1M)"><input type="number" step="0.01" className="input" value={model.pricing.input} onChange={(e) => setPricing("input", Number(e.target.value))} /></Field>
        <Field label="Cached input ($/1M)"><input type="number" step="0.01" className="input" value={model.pricing.input_cached} onChange={(e) => setPricing("input_cached", Number(e.target.value))} /></Field>
        <Field label="Output ($/1M)"><input type="number" step="0.01" className="input" value={model.pricing.output} onChange={(e) => setPricing("output", Number(e.target.value))} /></Field>
      </div>
    </div>
  );
}

function RuleRow({
  rule, models, index, onChange, onDelete, onMoveUp, onMoveDown,
}: {
  rule: any; models: PolicyModel[]; index: number;
  onChange: (r: any) => void; onDelete: () => void;
  onMoveUp?: () => void; onMoveDown?: () => void;
}) {
  const isDefault = "default" in rule;
  function setMatcher(k: string, v: any) {
    const when = { ...(rule.when ?? {}), [k]: v };
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete when[k];
    onChange({ ...rule, when });
  }
  function setRC(op: string, v: number | undefined) {
    const rc = { ...(rule.when?.retry_count ?? {}) };
    if (v === undefined || Number.isNaN(v)) delete rc[op]; else rc[op] = v;
    const when = { ...(rule.when ?? {}) };
    if (Object.keys(rc).length === 0) delete when.retry_count; else when.retry_count = rc;
    onChange({ ...rule, when });
  }

  return (
    <div className={`border rounded-lg p-3 ${isDefault ? "bg-slate-100 border-slate-300" : "bg-white border-slate-200"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-slate-500 w-6 text-center">{isDefault ? "DEF" : `#${index + 1}`}</span>
        <span className="text-xs text-slate-500">Use model:</span>
        <select className="input !w-auto !py-1" value={(rule.use ?? rule.default) ?? ""} onChange={(e) => onChange(isDefault ? { ...rule, default: e.target.value } : { ...rule, use: e.target.value })}>
          {models.length === 0 && <option value="">— (no models)</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
        <input className="input flex-1 text-xs" placeholder="Reason (shown in audit)" value={rule.reason ?? ""} onChange={(e) => onChange({ ...rule, reason: e.target.value })} />
        <div className="flex gap-1">
          {onMoveUp && <button onClick={onMoveUp} className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50" title="Move up">↑</button>}
          {onMoveDown && <button onClick={onMoveDown} className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50" title="Move down">↓</button>}
          <button onClick={onDelete} className="px-2 py-1 text-xs text-rose-600 hover:underline">Delete</button>
        </div>
      </div>

      {!isDefault && (
        <div className="grid grid-cols-4 gap-2 text-sm">
          <Field label="Phase">
            <select className="input" value={Array.isArray(rule.when?.phase) ? "_multi_" : (rule.when?.phase ?? "")} onChange={(e) => setMatcher("phase", e.target.value || undefined)}>
              <option value="">any</option>
              {PHASES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Task type (comma-sep for any-of)">
            <input className="input" value={Array.isArray(rule.when?.task_type) ? rule.when.task_type.join(", ") : (rule.when?.task_type ?? "")}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw.trim()) return setMatcher("task_type", undefined);
                const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
                setMatcher("task_type", items.length > 1 ? items : items[0]);
              }} placeholder="e.g. controller_handler, dto"/>
          </Field>
          <Field label="Module">
            <input className="input" value={rule.when?.module ?? ""} onChange={(e) => setMatcher("module", e.target.value || undefined)} placeholder="e.g. auth, employees" />
          </Field>
          <Field label="Retry count condition">
            <div className="flex gap-1 mt-1">
              <select className="input flex-1" value={rule.when?.retry_count ? Object.keys(rule.when.retry_count)[0] ?? "" : ""} onChange={(e) => {
                const op = e.target.value;
                if (!op) return setMatcher("retry_count", undefined);
                const existing = rule.when?.retry_count ? Object.values(rule.when.retry_count)[0] as number : 1;
                onChange({ ...rule, when: { ...(rule.when ?? {}), retry_count: { [op]: existing } } });
              }}>
                <option value="">none</option>
                <option value="lt">{"<"}</option>
                <option value="lte">{"≤"}</option>
                <option value="gt">{">"}</option>
                <option value="gte">{"≥"}</option>
                <option value="eq">{"="}</option>
              </select>
              <input type="number" className="input w-16" value={rule.when?.retry_count ? Object.values(rule.when.retry_count)[0] as number : 0} onChange={(e) => {
                const op = rule.when?.retry_count ? Object.keys(rule.when.retry_count)[0] : "gte";
                setRC(op, Number(e.target.value));
              }} disabled={!rule.when?.retry_count} />
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── yaml editor ─────────────────────────
function YamlEditor({ yamlText, yamlError, onChange }: { yamlText: string; yamlError: string | null; onChange: (t: string) => void }) {
  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-2">YAML editor</h2>
      <p className="text-sm text-slate-500 mb-3">Edits here flow back to the form view. Invalid YAML stays in this editor only.</p>
      <textarea
        value={yamlText}
        onChange={(e) => onChange(e.target.value)}
        className="w-full font-mono text-xs h-[600px] p-3 bg-slate-50 border border-slate-300 rounded shadow-inner resize-none focus:outline-none focus:bg-white focus:border-brand-600 focus:ring-2 focus:ring-brand-500/30 transition"
        spellCheck={false}
      />
      {yamlError && <div className="mt-2 text-sm text-rose-700">YAML error: {yamlError}</div>}
    </section>
  );
}

// ───────────────────────── helpers ─────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

function blankPolicy(): Policy {
  return { version: 1, name: "new-policy", models: [], rules: [{ default: "", reason: "fallback" }] };
}
function blankModel(): PolicyModel {
  return { id: "model-x", adapter: "mcp:gemini-flash-server", model_name: "gemini-2.5-flash", pricing: { input: 0.30, input_cached: 0.075, output: 2.50 }, auth: { env: "GEMINI_API_KEY" } };
}
function blankRule(): any {
  return { when: {}, use: "", reason: "" };
}

const PHASES = [
  "requirements_analysis", "architecture_design", "plan_task_packets",
  "codegen", "tests", "docs", "debug",
  "senior_code_review", "security_review", "refactor",
];

function collectErrors(p: Policy): string[] {
  const errs: string[] = [];
  if (!p.name?.trim()) errs.push("Policy needs a name.");
  if (!p.models?.length) errs.push("Policy needs at least one model.");
  const ids = new Set<string>();
  p.models?.forEach((m, i) => {
    if (!m.id?.trim()) errs.push(`Model #${i + 1}: id required.`);
    else if (ids.has(m.id)) errs.push(`Model id '${m.id}' is duplicated.`);
    ids.add(m.id);
    if (!m.model_name?.trim()) errs.push(`Model '${m.id}': model_name required.`);
    if (!m.pricing || m.pricing.input < 0 || m.pricing.output < 0) errs.push(`Model '${m.id}': pricing fields must be ≥ 0.`);
  });
  if (!p.rules?.length) errs.push("Policy needs at least one rule.");
  let defaultCount = 0;
  p.rules?.forEach((r, i) => {
    if ("default" in r) {
      defaultCount++;
      if (!r.default || !ids.has(r.default)) errs.push(`Default rule references unknown model id '${r.default || "(empty)"}'.`);
    } else {
      if (!r.use || !ids.has(r.use)) errs.push(`Rule #${i + 1} references unknown model id '${r.use || "(empty)"}'.`);
    }
  });
  if (defaultCount !== 1) errs.push(`Expected exactly 1 default rule, got ${defaultCount}.`);
  return errs;
}

function validatePolicy(p: any): void {
  if (!p || typeof p !== "object") throw new Error("YAML root must be an object");
  if (typeof p.version !== "number") throw new Error("version must be a number");
  if (typeof p.name !== "string") throw new Error("name must be a string");
  if (!Array.isArray(p.models)) throw new Error("models must be an array");
  if (!Array.isArray(p.rules)) throw new Error("rules must be an array");
}
