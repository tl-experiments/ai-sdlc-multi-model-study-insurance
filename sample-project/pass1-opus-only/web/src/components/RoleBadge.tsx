import React from "react";

export function RoleBadge({ role }: { role: string }) {
  const cls = {
    admin: "pill-admin",
    manager: "pill-manager",
    employee: "pill-employee",
    auditor: "pill-auditor",
  }[role] ?? "pill bg-slate-100 text-slate-600";
  return <span className={cls}>{role}</span>;
}
