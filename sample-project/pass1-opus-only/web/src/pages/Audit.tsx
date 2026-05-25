import React, { useEffect, useState } from "react";
import { AuditApi, type AuditLog } from "../lib/api";

export function AuditPage() {
  const [list, setList] = useState<AuditLog[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    AuditApi.list().then(setList).catch((e) => setErr(e?.message ?? "load failed")).finally(() => setBusy(false));
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Audit log</h1>
      <p className="text-sm text-slate-500">Append-only record of every PII read/write. Visible to the <code>auditor</code> role only.</p>
      {err && <div className="card text-rose-600 text-sm">{err}</div>}
      {busy ? <div className="card text-slate-500">Loading…</div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b border-slate-200">
              <th className="py-2 pr-3">Timestamp</th><th className="py-2 pr-3">Action</th>
              <th className="py-2 pr-3">Actor</th><th className="py-2 pr-3">Target</th>
              <th className="py-2 pr-3">Fields</th><th className="py-2 pr-3">Request ID</th>
            </tr></thead>
            <tbody>{list.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 align-top">
                <td className="py-2 pr-3 font-mono">{new Date(a.ts).toLocaleString()}</td>
                <td className="py-2 pr-3"><span className="pill bg-slate-100 text-slate-800">{a.action}</span></td>
                <td className="py-2 pr-3 font-mono text-xs">{a.actor_id?.slice(0, 12)}…</td>
                <td className="py-2 pr-3 font-mono text-xs">{a.target_id?.slice(0, 12) ?? "—"}…</td>
                <td className="py-2 pr-3 text-xs"><code>{a.fields}</code></td>
                <td className="py-2 pr-3 font-mono text-xs">{a.request_id?.slice(0, 8)}…</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
