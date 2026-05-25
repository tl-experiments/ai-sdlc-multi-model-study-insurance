/** Role-aware PII masking per ADR-003. */
import type { AuthUser } from "./current-user.decorator";

const PII_FIELDS = ["phone", "address", "government_id", "bank_account", "salary_base"] as const;

export interface EmployeeView {
  id: string;
  username: string;
  role: string;
  full_name: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  government_id?: string | null;
  bank_account?: string | null;
  salary_base?: string | null;
  reports_to_id?: string | null;
  created_at: Date;
}

function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "***";
  return value.slice(0, 2) + "***" + value.slice(-2);
}

export function maskEmployee(view: EmployeeView, viewer: AuthUser, managerChain: Set<string>): EmployeeView {
  const isAdmin = viewer.role === "admin";
  const isSelf = viewer.id === view.id;
  const isManagerOfSubject = managerChain.has(viewer.id);

  if (isAdmin || isSelf) return view;

  const out: EmployeeView = { ...view };
  for (const field of PII_FIELDS) {
    const value = out[field];
    if (value == null) continue;
    if (isManagerOfSubject && (field === "phone" || field === "address")) continue;
    out[field] = mask(value);
  }
  return out;
}