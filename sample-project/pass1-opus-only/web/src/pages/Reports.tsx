import React, { useEffect, useState } from "react";
import { Reports } from "../lib/api";

export function ReportsPage() {
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [util, setUtil] = useState<any[] | null>(null);
  const [bal, setBal] = useState<any[] | null>(null);
  const [hc, setHc] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setErr(null);
    try {
      const [u, b, h] = await Promise.all([Reports.utilization(from, to), Reports.leaveBalance(), Reports.headcount(to)]);
      setUtil(u); setBal(b); setHc(h);
    } catch (e: any) { setErr(e?.message ?? "load failed"); }
    finally { setBusy(false); }
  }
  useEffect(() => { run(); /* eslint-disable-line */ }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Reports</h1>
      <div className="card flex items-end gap-3">
        <div><label className="label">From</label><input type="date" className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">To</label><input type="date" className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button className="btn-primary" onClick={run} disabled={busy}>{busy ? "Running…" : "Run"}</button>
      </div>
      {err && <div className="card text-rose-600 text-sm">{err}</div>}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card">
          <h3 className="font-semibold mb-3">Utilization</h3>
          {util ? (util.length === 0 ? <p className="text-slate-500 text-sm">No clocked sessions in range.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left border-b border-slate-200"><th className="py-2 pr-3">Employee</th><th className="py-2 pr-3">Hours</th><th className="py-2 pr-3">Util %</th></tr></thead>
              <tbody>{util.map((r) => (
                <tr key={r.employee_id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono">{r.employee_id.slice(0, 8)}…</td>
                  <td className="py-2 pr-3">{r.billable_hours}h</td>
                  <td className="py-2 pr-3">{r.utilization_pct}%</td>
                </tr>
              ))}</tbody>
            </table>
          )) : <div className="text-slate-500 text-sm">—</div>}
        </div>
        <div className="card">
          <h3 className="font-semibold mb-3">Leave balances</h3>
          {bal ? (
            <table className="w-full text-sm">
              <thead><tr className="text-left border-b border-slate-200"><th className="py-2 pr-3">Employee</th><th className="py-2 pr-3">Annual</th><th className="py-2 pr-3">Sick</th><th className="py-2 pr-3">Unpaid</th><th className="py-2 pr-3">Comp-off</th></tr></thead>
              <tbody>{bal.map((r) => (
                <tr key={r.employee_id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono">{r.employee_id.slice(0, 8)}…</td>
                  <td className="py-2 pr-3">{r.balances?.annual ?? "—"}</td>
                  <td className="py-2 pr-3">{r.balances?.sick ?? "—"}</td>
                  <td className="py-2 pr-3">{r.balances?.unpaid ?? "—"}</td>
                  <td className="py-2 pr-3">{r.balances?.comp_off ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div className="text-slate-500 text-sm">—</div>}
        </div>
        <div className="card lg:col-span-2">
          <h3 className="font-semibold mb-3">Headcount</h3>
          {hc ? (<p className="text-sm">As of <strong>{new Date(hc.as_of).toLocaleDateString()}</strong>: <span className="text-2xl font-bold">{hc.headcount}</span> employees</p>)
              : <div className="text-slate-500 text-sm">—</div>}
        </div>
      </div>
    </div>
  );
}
