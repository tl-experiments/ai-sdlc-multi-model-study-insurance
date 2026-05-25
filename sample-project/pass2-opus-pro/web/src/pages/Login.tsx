import React, { useState } from "react";
import { useAuth } from "../lib/auth";
import { useNavigate } from "react-router-dom";
import { THEME } from "../lib/theme";

const PRESETS = [
  { username: "admin",    password: "admin123", label: "Admin (full visibility)" },
  { username: "mgr1",     password: "mgr1pass", label: "Manager (sees reports, masked)" },
  { username: "emp1",     password: "emp1pass", label: "Employee (sees self)" },
  { username: "auditor1", password: "audpass",  label: "Auditor (audit log access)" },
];

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null); setBusy(true);
    try { await login(u, p); nav("/employees"); }
    catch (e: any) { setErr(e?.message ?? "login failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-50">
      <div className="w-full max-w-md card">
        <div className="text-xs uppercase tracking-wider text-brand-700 font-semibold">{THEME.pass}</div>
        <h1 className="text-2xl font-bold mt-1">Workforce Operations</h1>
        <p className="text-sm text-slate-500 mt-1 mb-5">{THEME.bannerNote}</p>
        <form onSubmit={go} className="space-y-3">
          <div><label className="label">Username</label><input className="input mt-1" value={u} onChange={(e) => setU(e.target.value)} autoFocus /></div>
          <div><label className="label">Password</label><input className="input mt-1" type="password" value={p} onChange={(e) => setP(e.target.value)} /></div>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <button className="btn-primary w-full" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <div className="mt-6">
          <div className="label">Seeded demo accounts</div>
          <div className="grid grid-cols-1 gap-2 mt-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.username}
                onClick={() => { setU(preset.username); setP(preset.password); }}
                className="text-left px-3 py-2 rounded border border-slate-200 hover:bg-slate-50 text-sm flex items-center justify-between"
              >
                <span><span className="font-mono">{preset.username}</span> <span className="text-slate-400">/ {preset.password}</span></span>
                <span className="text-slate-500 text-xs">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}