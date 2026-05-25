import React from "react";

interface RoleBadgeProps {
  role: string;
}

export function RoleBadge({ role }: RoleBadgeProps) {
  const normalized = role.toLowerCase();
  const cls = (
    {
      admin: "pill-admin",
      manager: "pill-manager",
      employee: "pill-employee",
      auditor: "pill-auditor",
    } as Record<string, string>
  )[normalized] ?? "pill bg-slate-100 text-slate-600";

  return <span className={cls}>{role}</span>;
}