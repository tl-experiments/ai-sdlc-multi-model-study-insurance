import React, { useEffect, useState } from "react";
import { LeaveRequests, type LeaveRequest } from "../lib/api";
import { useAuth } from "../lib/auth";

export function LeaveRequestsPage() {
  const { user } = useAuth();
  const [list, setList] = useState<LeaveRequest[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ leave_type: "annual", from_date: "", to_date: "", comments: "" });

  async function reload() {
    setBusy(true); setErr(null);
    try { setList(await LeaveRequests.list()); }
    catch (e: any) { setErr(e?.message ?? "load failed"); }
    finally { setBusy(false); }
  }
  useEffect(() => { reload(); }, []);

  async function submit() {
    setErr(null);
    if (!form.from_date || !form.to_date) { setErr("Pick dates"); return; }
    try { await LeaveRequests.submit(form); setForm({ leave_type: "annual", from_date: "", to_date: "", comments: "" }); reload(); }
    catch (e: any) { setErr(e?.message ?? "submit failed"); }
  }
  async function decide(id: string, action: "approve" | "reject") {
    setErr(null);
    try {
      if (action === "approve") await LeaveRequests.approve(id); else await LeaveRequests.reject(id);
      reload();
    } catch (e: any) { setErr(e?.message ?? `${action} failed`); }
  }

  const canApprove = user?.role === "manager" || user?.role === "admin";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Leave requests</h1>
      <div className="card">
        <h3 className="font-semibold mb-2">Submit a leave request</h3>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <div>
            <label className="label">Type</label>
            <select className="input mt-1" value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
              <option value="annual">Annual</option><option value="sick">Sick</option>
              <option value="unpaid">Unpaid</option><option value="comp_off">Comp-off</option>
            </select>
          </div>
          <div><label className="label">From</label><input type="date" className="input mt-1" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} /></div>
          <div><label className="label">To</label><input type="date" className="input mt-1" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} /></div>
          <div><label className="label">Comments</label><input className="input mt-1" value={form.comments} onChange={(e) => setForm({ ...form, comments: e.target.value })} /></div>
        </div>
        {err && <div className="text-sm text-rose-600 mt-3">{err}</div>}
        <div className="mt-3 flex justify-end"><button className="btn-primary" onClick={submit}>Submit</button></div>
      </div>
      <div className="card">
        <h3 className="font-semibold mb-3">{canApprove ? "All visible requests" : "Your requests"}</h3>
        {busy ? <div className="text-slate-500">Loading…</div> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b border-slate-200">
              <th className="py-2 pr-3">Type</th><th className="py-2 pr-3">From → To</th>
              <th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Comments</th>
              {canApprove && <th className="py-2 pr-3">Decide</th>}
            </tr></thead>
            <tbody>{list.map((lr) => (
              <tr key={lr.id} className="border-b border-slate-100">
                <td className="py-2 pr-3 capitalize">{lr.leave_type.replace("_", " ")}</td>
                <td className="py-2 pr-3 font-mono">{lr.from_date.slice(0,10)} → {lr.to_date.slice(0,10)}</td>
                <td className="py-2 pr-3">
                  <span className={`pill ${lr.status === "approved" ? "bg-emerald-100 text-emerald-800" : lr.status === "rejected" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}>{lr.status}</span>
                </td>
                <td className="py-2 pr-3 text-slate-500">{lr.comments ?? "—"}</td>
                {canApprove && (
                  <td className="py-2 pr-3">
                    {lr.status === "pending" ? (
                      <div className="flex gap-2">
                        <button className="btn-primary py-1 px-2 text-xs" onClick={() => decide(lr.id, "approve")}>Approve</button>
                        <button className="btn-danger py-1 px-2 text-xs" onClick={() => decide(lr.id, "reject")}>Reject</button>
                      </div>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                )}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
