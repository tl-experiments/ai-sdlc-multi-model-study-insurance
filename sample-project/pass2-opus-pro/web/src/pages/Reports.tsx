import React, { useEffect, useState } from "react";
import { Reports } from "../lib/api";

// Define interfaces for the report data structures for type safety
interface UtilizationReportItem {
  employee_id: string;
  billable_hours: number;
  utilization_pct: number;
}

interface LeaveBalanceReportItem {
  employee_id: string;
  balances: {
    annual?: number;
    sick?: number;
    unpaid?: number;
    comp_off?: number;
  };
}

interface HeadcountReport {
  as_of: string;
  headcount: number;
}

export function ReportsPage() {
  // State for date range filters
  const [from, setFrom] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  // State for report data, with improved naming and types
  const [utilization, setUtilization] = useState<UtilizationReportItem[] | null>(null);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalanceReportItem[] | null>(null);
  const [headcount, setHeadcount] = useState<HeadcountReport | null>(null);

  // State for UI feedback
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function runReports() {
    setIsLoading(true);
    setError(null);
    try {
      // Fetch all reports in parallel for efficiency
      const [utilData, balanceData, headcountData] = await Promise.all([
        Reports.utilization(from, to),
        Reports.leaveBalance(),
        Reports.headcount(to),
      ]);
      setUtilization(utilData);
      setLeaveBalances(balanceData);
      setHeadcount(headcountData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load reports");
    } finally {
      setIsLoading(false);
    }
  }

  // Fetch reports on initial component mount.
  // The dependency array is intentionally empty to run only once, matching original behavior.
  useEffect(() => {
    runReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Reports</h1>
      <div className="card flex items-end gap-3">
        <div>
          <label className="label">From</label>
          <input type="date" className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={runReports} disabled={isLoading}>
          {isLoading ? "Running…" : "Run"}
        </button>
      </div>

      {error && <div className="card text-rose-600 text-sm">{error}</div>}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card">
          <h3 className="font-semibold mb-3">Utilization</h3>
          {utilization ? (
            utilization.length === 0 ? (
              <p className="text-slate-500 text-sm">No clocked sessions in range.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-slate-200">
                    <th className="py-2 pr-3">Employee</th>
                    <th className="py-2 pr-3">Hours</th>
                    <th className="py-2 pr-3">Util %</th>
                  </tr>
                </thead>
                <tbody>
                  {utilization.map((r) => (
                    <tr key={r.employee_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-mono">{r.employee_id.slice(0, 8)}…</td>
                      <td className="py-2 pr-3">{r.billable_hours}h</td>
                      <td className="py-2 pr-3">{r.utilization_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <div className="text-slate-500 text-sm">—</div>
          )}
        </div>

        <div className="card">
          <h3 className="font-semibold mb-3">Leave balances</h3>
          {leaveBalances ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-slate-200">
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3">Annual</th>
                  <th className="py-2 pr-3">Sick</th>
                  <th className="py-2 pr-3">Unpaid</th>
                  <th className="py-2 pr-3">Comp-off</th>
                </tr>
              </thead>
              <tbody>
                {leaveBalances.map((r) => (
                  <tr key={r.employee_id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 font-mono">{r.employee_id.slice(0, 8)}…</td>
                    <td className="py-2 pr-3">{r.balances?.annual ?? "—"}</td>
                    <td className="py-2 pr-3">{r.balances?.sick ?? "—"}</td>
                    <td className="py-2 pr-3">{r.balances?.unpaid ?? "—"}</td>
                    <td className="py-2 pr-3">{r.balances?.comp_off ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-slate-500 text-sm">—</div>
          )}
        </div>

        <div className="card lg:col-span-2">
          <h3 className="font-semibold mb-3">Headcount</h3>
          {headcount ? (
            <p className="text-sm">
              As of <strong>{new Date(headcount.as_of).toLocaleDateString()}</strong>:{" "}
              <span className="text-2xl font-bold">{headcount.headcount}</span> employees
            </p>
          ) : (
            <div className="text-slate-500 text-sm">—</div>
          )}
        </div>
      </div>
    </div>
  );
}