import React, { useEffect, useState } from "react";
import { TimeEntries, type TimeEntry } from "../lib/api";

export function TimeEntriesPage() {
  const [list, setList] = useState<TimeEntry[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [project, setProject] = useState("PROJ-A");

  async function reload() {
    setBusy(true); setErr(null);
    try { setList(await TimeEntries.list()); }
    catch (e: any) { setErr(e?.message ?? "load failed"); }
    finally { setBusy(false); }
  }
  useEffect(() => { reload(); }, []);

  const openEntry = list.find((e) => e.clock_out_at === null);
  async function clockIn() { setErr(null); try { await TimeEntries.clockIn(project); reload(); } catch (e: any) { setErr(e?.message ?? "clock-in failed"); } }
  async function clockOut() { setErr(null); try { await TimeEntries.clockOut(); reload(); } catch (e: any) { setErr(e?.message ?? "clock-out failed"); } }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Time entries</h1>
      <div className="card">
        <div className="flex items-end gap-3">
          {openEntry ? (
            <>
              <div><div className="label">Currently clocked in</div><div className="font-mono text-sm">{openEntry.project_tag} · since {new Date(openEntry.clock_in_at).toLocaleTimeString()}</div></div>
              <button className="btn-danger ml-auto" onClick={clockOut}>Clock out</button>
            </>
          ) : (
            <>
              <div><label className="label">Project tag</label><input className="input mt-1 w-44" value={project} onChange={(e) => setProject(e.target.value)} /></div>
              <button className="btn-primary" onClick={clockIn}>Clock in</button>
            </>
          )}
        </div>
        {err && <div className="text-sm text-rose-600 mt-3">{err}</div>}
      </div>
      <div className="card">
        <h3 className="font-semibold mb-3">Recent entries</h3>
        {busy ? <div className="text-slate-500">Loading…</div> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b border-slate-200">
              <th className="py-2 pr-3">Project</th><th className="py-2 pr-3">In</th>
              <th className="py-2 pr-3">Out</th><th className="py-2 pr-3">Duration</th><th className="py-2 pr-3">Status</th>
            </tr></thead>
            <tbody>{list.slice(0, 25).map((e) => {
              const dur = e.clock_out_at ? `${((+new Date(e.clock_out_at) - +new Date(e.clock_in_at)) / 3600000).toFixed(2)}h` : "—";
              return (
                <tr key={e.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono">{e.project_tag}</td>
                  <td className="py-2 pr-3">{new Date(e.clock_in_at).toLocaleString()}</td>
                  <td className="py-2 pr-3">{e.clock_out_at ? new Date(e.clock_out_at).toLocaleString() : <span className="text-emerald-600">open</span>}</td>
                  <td className="py-2 pr-3">{dur}</td>
                  <td className="py-2 pr-3">{e.approval_status}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
