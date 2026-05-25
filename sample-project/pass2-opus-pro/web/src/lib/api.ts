/** Lightweight fetch wrapper. JWT in localStorage, all requests via /api proxy. */
import { THEME } from "./theme";

const TOKEN_KEY = `mmo:${THEME.pass.toLowerCase().replace(" ", "")}:token`;

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = getToken();
  if (t) headers["Authorization"] = `Bearer ${t}`;
  const res = await fetch(`${THEME.apiBase}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const e: any = new Error(err.message ?? `${res.status}`);
    e.status = res.status; e.body = err;
    throw e;
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? await res.json() : (await res.text())) as T;
}

export const api = {
  get:    <T>(p: string) => req<T>("GET", p),
  post:   <T>(p: string, b?: unknown) => req<T>("POST", p, b),
  patch:  <T>(p: string, b?: unknown) => req<T>("PATCH", p, b),
  delete: <T>(p: string) => req<T>("DELETE", p),
};

export interface AuthMe { id: string; role: string; username: string }
export interface Employee {
  id: string; username: string; role: string;
  full_name: string; email: string;
  phone?: string | null; address?: string | null;
  government_id?: string | null; bank_account?: string | null; salary_base?: string | null;
  reports_to_id?: string | null; created_at: string;
}
export interface TimeEntry {
  id: string; employee_id: string; project_tag: string;
  clock_in_at: string; clock_out_at: string | null; approval_status: string;
}
export interface LeaveRequest {
  id: string; employee_id: string; leave_type: string;
  from_date: string; to_date: string; status: string;
  decided_by: string | null; comments: string | null;
}
export interface AuditLog {
  id: string; actor_id: string; action: string; target_id: string | null;
  fields: string; request_id: string; ts: string;
}

export const Auth = {
  login: (username: string, password: string) =>
    api.post<{ access_token: string; role: string }>("/auth/login", { username, password }),
  me: () => api.get<AuthMe>("/auth/me"),
};
export const Employees = {
  list:  (page = 1, size = 25) => api.get<{ items: Employee[]; total: number }>(`/employees?page=${page}&size=${size}`),
  get:   (id: string) => api.get<Employee>(`/employees/${id}`),
  create:(dto: Partial<Employee> & { username: string; password: string; role: string; full_name: string; email: string }) =>
            api.post<Employee>("/employees", dto),
};
export const TimeEntries = {
  clockIn:  (project_tag: string) => api.post<TimeEntry>("/time-entries/clock-in", { project_tag }),
  clockOut: () => api.post<TimeEntry>("/time-entries/clock-out"),
  list:     (employee_id?: string) =>
              api.get<TimeEntry[]>(`/time-entries${employee_id ? `?employee_id=${employee_id}` : ""}`),
};
export const LeaveRequests = {
  list:    (employee_id?: string, status?: string) => {
    const q = new URLSearchParams();
    if (employee_id) q.set("employee_id", employee_id);
    if (status) q.set("status", status);
    return api.get<LeaveRequest[]>(`/leave-requests${q.toString() ? `?${q}` : ""}`);
  },
  submit:  (dto: { leave_type: string; from_date: string; to_date: string; comments?: string }) =>
            api.post<LeaveRequest>("/leave-requests", dto),
  approve: (id: string, comments?: string) => api.post<LeaveRequest>(`/leave-requests/${id}/approve`, { comments }),
  reject:  (id: string, comments?: string) => api.post<LeaveRequest>(`/leave-requests/${id}/reject`, { comments }),
};
export const Reports = {
  utilization: (from: string, to: string) => api.get<any[]>(`/reports/utilization?from=${from}&to=${to}`),
  leaveBalance: () => api.get<any[]>("/reports/leave-balance"),
  headcount: (as_of: string) => api.get<any>(`/reports/headcount?as_of=${as_of}`),
};
export const AuditApi = { list: () => api.get<AuditLog[]>("/audit") };