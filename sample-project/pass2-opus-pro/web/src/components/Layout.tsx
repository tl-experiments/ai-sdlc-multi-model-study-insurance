import React from "react";
import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { RoleBadge } from "./RoleBadge";
import { THEME } from "../lib/theme";

const navItems = [
  { to: "/employees",      label: "Employees",  roles: ["admin", "manager", "employee", "auditor"] },
  { to: "/time-entries",   label: "Time",       roles: ["admin", "manager", "employee", "auditor"] },
  { to: "/leave-requests", label: "Leave",      roles: ["admin", "manager", "employee", "auditor"] },
  { to: "/reports",        label: "Reports",    roles: ["admin", "manager", "auditor"] },
  { to: "/audit",          label: "Audit log",  roles: ["auditor"] },
];

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-brand-700 text-white px-6 py-3 flex items-center gap-6 shadow-md">
        <div className="font-bold tracking-tight text-base">Workforce Ops</div>
        <div className="text-xs uppercase tracking-wider text-white/80 font-semibold">
          {THEME.pass} · {THEME.subtitle}
        </div>
        <nav className="flex gap-1 ml-6">
          {navItems
            .filter((n) => user && n.roles.includes(user.role))
            .map((n) => {
              const active = loc.pathname.startsWith(n.to);
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition ${
                    active ? "bg-white text-brand-800 shadow-sm" : "text-white hover:bg-white/15"
                  }`}
                >{n.label}</Link>
              );
            })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user && (
            <>
              <span className="text-white/85">{user.username}</span>
              <RoleBadge role={user.role} />
              <button
                className="px-3 py-1.5 rounded text-sm font-medium bg-white/15 text-white border border-white/30 hover:bg-white/25 transition"
                onClick={() => { logout(); nav("/login"); }}
              >Sign out</button>
            </>
          )}
        </div>
      </header>
      <div className="bg-slate-100 px-6 py-2 text-xs text-slate-600 border-b border-slate-200">
        {THEME.bannerNote}
      </div>
      <main className="flex-1 p-6 max-w-6xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  );
}