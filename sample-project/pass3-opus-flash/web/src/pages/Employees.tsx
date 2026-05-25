import React, { useEffect, useState } from "react";
import { Employees, type Employee } from "../lib/api";
import { RoleBadge } from "../components/RoleBadge";
import { useAuth } from "../lib/auth";

function isMasked(v: string | null | undefined): boolean { 
  return !!v && /\*\*\*/.test(v); 
}

function piiCell(label: string, value: string | null | undefined) {
  if (!value) return <span className="text-slate-300">—</span>;
  if (isMasked(value)) {
    return (
      <span>
        <span className="font-mono">{value}</span>
        <span className="pill-pii-masked ml-1 text-xs px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">masked</span>
      </span>
    );
  }
  return (
    <span>
      <span className="font-mono">{value}</span>
      <span className="pill-pii-cleartext ml-1 text-xs px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded">cleartext</span>
    </span>
  );
}

export function EmployeesPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function reload() {
    setBusy(true); 
    setErr(null);
    try { 
      const res = await Employees.list(); 
      setData(res.items); 
    } catch (e: any) {
      setErr(e?.message ?? "load failed"); 
    } finally { 
      setBusy(false); 
    }
  }

  useEffect(() => { 
    reload(); 
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Employees</h1>
          <p className="text-sm text-slate-500">
            Same dataset, role-aware PII rendering. You are <code>{user?.username}</code> · <RoleBadge role={user?.role ?? ""} />.
          </p>
        </div>
        {user?.role === "admin" && (
          <button className="btn-primary bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700" onClick={() => setCreating(true)}>
            + New employee
          </button>
        )}
      </div>
      {err && <div className="card text-rose-600 text-sm p-4 border border-rose-200 rounded bg-rose-50">{err}</div>}
      {busy ? (
        <div className="card text-slate-500 p-4 border border-slate-200 rounded bg-slate-50">Loading…</div>
      ) : (
        <div className="card overflow-x-auto border border-slate-200 rounded bg-white p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200">
                <th className="py-2 pr-3">Name / Username</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Phone</th>
                <th className="py-2 pr-3">Gov ID</th>
                <th className="py-2 pr-3">Bank acc</th>
                <th className="py-2 pr-3">Salary</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{e.full_name}</div>
                    <div className="text-xs text-slate-500 font-mono">{e.username}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <RoleBadge role={e.role} />
                  </td>
                  <td className="py-2 pr-3">{e.email}</td>
                  <td className="py-2 pr-3">{piiCell("phone", e.phone)}</td>
                  <td className="py-2 pr-3">{piiCell("gov", e.government_id)}</td>
                  <td className="py-2 pr-3">{piiCell("bank", e.bank_account)}</td>
                  <td className="py-2 pr-3">{piiCell("salary", e.salary_base)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <CreateModal 
          onClose={() => setCreating(false)} 
          onCreated={() => { setCreating(false); reload(); }} 
        />
      )}
    </div>
  );
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    username: "",
    password: "",
    full_name: "",
    email: "",
    role: "employee",
    phone: "",
    address: "",
    government_id: "",
    bank_account: "",
    salary_base: ""
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    setBusy(true); 
    setErr(null);
    try { 
      await Employees.create(form as any); 
      onCreated(); 
    } catch (e: any) {
      setErr(e?.message ?? "create failed"); 
    } finally { 
      setBusy(false); 
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 grid place-items-center z-20">
      <div className="card w-full max-w-lg bg-white p-6 rounded-lg shadow-xl border border-slate-200">
        <h3 className="text-lg font-bold mb-3">New employee</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ["username", "Username"],
            ["password", "Password"],
            ["full_name", "Full name"],
            ["email", "Email"],
            ["role", "Role"],
            ["phone", "Phone"],
            ["address", "Address"],
            ["government_id", "Gov ID"],
            ["bank_account", "Bank acct"],
            ["salary_base", "Salary"]
          ].map(([k, lab]) => (
            <div key={k}>
              <label className="label block text-xs font-semibold text-slate-600">{lab}</label>
              <input 
                className="input mt-1 w-full border border-slate-300 rounded px-2 py-1 focus:outline-none focus:border-blue-500" 
                value={(form as any)[k]} 
                onChange={(e) => set(k, e.target.value)} 
              />
            </div>
          ))}
        </div>
        {err && <div className="text-sm text-rose-600 mt-3">{err}</div>}
        <div className="flex gap-2 mt-4 justify-end">
          <button className="btn-ghost px-4 py-2 rounded hover:bg-slate-100" onClick={onClose}>Cancel</button>
          <button 
            className="btn-primary bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50" 
            disabled={busy} 
            onClick={submit}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}