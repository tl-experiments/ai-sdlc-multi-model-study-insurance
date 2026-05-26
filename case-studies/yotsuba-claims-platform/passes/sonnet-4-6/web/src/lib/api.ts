/**
 * api.ts
 *
 * Typed fetch wrapper for the Yotsuba Claims Processing Platform API.
 *
 * Responsibilities:
 *  1. Attach the Bearer JWT from localStorage on every authenticated request.
 *  2. Inject a per-request `X-Request-Id` and propagate `X-Correlation-Id`.
 *  3. Normalise API errors into a typed `ApiError` shape matching the backend
 *     global exception filter envelope.
 *  4. Expose one typed function per backend endpoint (design.md §2 API contract).
 *  5. Never use `number` for yen amounts — all monetary fields are `string`
 *     (Prisma Decimal serialised to string over JSON).
 *
 * Auth storage:
 *  - `access_token` → localStorage key `yotsuba_jwt`
 *  - `current_user`  → localStorage key `yotsuba_user` (serialised JSON)
 */

// ─── Token storage keys ───────────────────────────────────────────────────────

const TOKEN_KEY = 'yotsuba_jwt';
const USER_KEY  = 'yotsuba_user';

// ─── Domain enums (mirror Prisma enums) ──────────────────────────────────────

export type UserRole = 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';

export type IntakeChannel =
  | 'agent'
  | 'mobile'
  | 'broker'
  | 'email';

export type IncidentType =
  | 'auto_collision'
  | 'auto_property_damage'
  | 'fire_residential'
  | 'fire_commercial'
  | 'marine_cargo'
  | 'liability_premises'
  | 'personal_accident';

export type ClaimSeverity = 'simple' | 'complex' | 'catastrophic';

export type ClaimStatus =
  | 'intake'
  | 'under_investigation'
  | 'awaiting_reserve_approval'
  | 'settlement_offered'
  | 'closed_paid'
  | 'closed_denied'
  | 'reopened';

export type EvidenceKind =
  | 'photo'
  | 'document'
  | 'audio'
  | 'video'
  | 'witness_statement_attachment';

export type ReserveCategory = 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

// ─── Entity shapes (API response types) ──────────────────────────────────────

export interface User {
  id: string;
  username: string;
  role: UserRole;
  display_name: string;
  email: string;
  is_claims_director: boolean;
  reports_to_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Claim {
  id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reported_by_channel: IntakeChannel;
  reporter_name: string;
  /** Masked for roles without adjuster-on-assigned access. */
  reporter_phone: string | null;
  /** Masked for roles without adjuster-on-assigned access. */
  reporter_email: string | null;
  reporter_relation_to_insured: string;
  incident_type: IncidentType;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number: string | null;
  severity_initial: ClaimSeverity;
  status: ClaimStatus;
  appi_consent_version: string;
  appi_consent_at: string;
  assigned_adjuster_id: string | null;
  assigned_adjuster: Pick<User, 'id' | 'display_name' | 'email'> | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimNote {
  id: string;
  claim_id: string;
  author_id: string;
  author: Pick<User, 'id' | 'display_name' | 'role'>;
  body: string;
  created_at: string;
}

export interface Evidence {
  id: string;
  claim_id: string;
  kind: EvidenceKind;
  content_hash: string;
  blob_ref: string;
  uploaded_by_id: string;
  uploaded_at: string;
}

export interface WitnessStatement {
  id: string;
  claim_id: string;
  witness_name: string;
  statement_body: string;
  inkan_seal_hash: string;
  recorded_by_id: string;
  recorded_at: string;
}

export interface Reserve {
  id: string;
  claim_id: string;
  category: ReserveCategory;
  /** Prisma Decimal(15,0) serialised as string. */
  proposed_yen: string;
  /** Prisma Decimal(15,0) serialised as string, or null for first reserve. */
  prior_yen: string | null;
  justification: string;
  proposed_by_id: string;
  proposed_at: string;
  approval_status: ApprovalStatus;
  approved_by_id: string | null;
  approved_at: string | null;
  director_approved_by_id: string | null;
  director_approved_at: string | null;
  reason_for_rejection: string | null;
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  actor_role: UserRole;
  action: string;
  claim_id: string | null;
  target_id: string | null;
  payload_hash: string;
  request_id: string;
  correlation_id: string;
  ts: string;
}

export interface NotificationToRegulator {
  id: string;
  kind: string;
  claim_id: string;
  reserve_id: string;
  /** Prisma Decimal(15,0) serialised as string. */
  amount_yen: string;
  triggered_at: string;
  sent_at: string | null;
}

/** Paginated list wrapper returned by GET /claims and GET /audit. */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
}

// ─── Auth shapes ─────────────────────────────────────────────────────────────

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  role: UserRole;
  user: User;
}

// ─── Request body shapes ─────────────────────────────────────────────────────

export interface CreateClaimBody {
  policy_number: string;
  loss_date: string;             // ISO-8601 date string
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reported_by_channel: IntakeChannel;
  reporter_name: string;
  reporter_phone?: string;
  reporter_email?: string;
  reporter_relation_to_insured: string;
  incident_type: IncidentType;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number?: string;
  appi_consent_version: string;
  appi_consent_at: string;       // ISO-8601 datetime
  attachments?: string[];
}

export interface AssignClaimBody {
  adjuster_id: string;
  reason_for_reassignment?: string;
}

export interface AddNoteBody {
  body: string;
}

export interface AddEvidenceBody {
  kind: EvidenceKind;
  content_hash: string;
  blob_ref: string;
}

export interface AddWitnessStatementBody {
  witness_name: string;
  witness_phone?: string;
  statement_body: string;
  inkan_seal_hash: string;
}

export interface UpdateStatusBody {
  to: ClaimStatus;
  reason: string;
}

export interface ProposeReserveBody {
  category: ReserveCategory;
  /** Prisma Decimal — send as string to avoid float precision loss. */
  proposed_yen: string;
  justification: string;
}

export interface RejectReserveBody {
  reason_for_rejection: string;
}

// ─── Query param shapes ──────────────────────────────────────────────────────

export interface ClaimsListQuery {
  status?: ClaimStatus;
  severity?: ClaimSeverity;
  channel?: IntakeChannel;
  assignee?: string;
  page?: number;
  per_page?: number;
}

export interface AuditListQuery {
  from?: string;
  to?: string;
  actor?: string;
  claim_id?: string;
  action?: string;
  page?: number;
  per_page?: number;
}

export interface ReservesExportQuery {
  period: string; // YYYY-MM
}

/** Shape returned by GET /reserves/export */
export interface ReservesExportRow {
  claim_id: string;
  category: ReserveCategory;
  period: string;
  /** Aggregated yen — Decimal serialised as string. */
  total_proposed_yen: string;
  approval_status: ApprovalStatus;
}

/** Shape returned by GET /claims/:id/data-subject-export (APPI Article 28) */
export interface DataSubjectExport {
  subject_reference: string;
  exported_at: string;
  claims: Array<{
    claim_id: string;
    reporter_name: string;
    reporter_phone: string | null;
    reporter_email: string | null;
    loss_location_prefecture: string;
    loss_location_postal_code: string;
    loss_location_detail: string;
    reporter_relation_to_insured: string;
    appi_consent_version: string;
    appi_consent_at: string;
    /** Special-care PII fields — only populated for explicit APPI export. */
    insured_government_id: string | null;
    bank_account_for_payout: string | null;
    injury_details: string | null;
  }>;
}

// ─── Error envelope ───────────────────────────────────────────────────────────

/**
 * Matches the global exception filter's standardised error envelope
 * (`error.filter.ts` in the backend).
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  request_id?: string;
  correlation_id?: string;
  timestamp: string;
}

/**
 * Typed error thrown by all API functions when the server returns a non-2xx
 * status. Callers can catch and inspect `status` + `body`.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(
      typeof body.message === 'string'
        ? body.message
        : body.message.join('; '),
    );
    this.name = 'ApiError';
  }
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

/**
 * Base URL for the API.  Defaults to the Vite dev-proxy target so that
 * `fetch('/claims/...')` works in both dev (proxied) and production (same
 * origin).  Override via `VITE_API_BASE_URL` env var.
 */
const API_BASE = (import.meta as Record<string, unknown> & { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? '';

/** Generate a compact v4-like request ID for correlation. */
function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Read the JWT from localStorage. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Persist the JWT to localStorage. */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Remove the JWT (and cached user) from localStorage. */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Read the cached current user from localStorage. */
export function getCachedUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

/** Persist the current user to localStorage. */
export function setCachedUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Additional headers merged with defaults. */
  headers?: Record<string, string>;
  /** If true, omit the Authorization header (used for /auth/login). */
  unauthenticated?: boolean;
  /**
   * Caller-supplied correlation ID.  If omitted, the request ID is reused
   * (sufficient for single-hop calls; multi-hop callers should supply one).
   */
  correlationId?: string;
}

/**
 * Core fetch wrapper.  All API functions delegate to this.
 *
 * @param path   - API path (e.g. '/claims/abc123').  Appended to API_BASE.
 * @param opts   - Options controlling method, body, auth, and correlation.
 * @returns      - Parsed JSON response of type `T`.
 * @throws ApiError on any non-2xx response.
 */
async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    headers: extraHeaders = {},
    unauthenticated = false,
    correlationId,
  } = opts;

  const requestId = newRequestId();
  const corrId = correlationId ?? requestId;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
    'X-Correlation-Id': corrId,
    ...extraHeaders,
  };

  if (!unauthenticated) {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Parse the body regardless of status so we can include it in ApiError.
  let parsed: unknown;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    parsed = await response.json();
  } else {
    // Non-JSON response (e.g. 204 No Content)
    parsed = null;
  }

  if (!response.ok) {
    // Attempt to treat the parsed body as our error envelope.
    const errorBody: ApiErrorBody = (parsed as ApiErrorBody) ?? {
      statusCode: response.status,
      error: response.statusText,
      message: response.statusText,
      timestamp: new Date().toISOString(),
    };
    throw new ApiError(response.status, errorBody);
  }

  return parsed as T;
}

// ─── Query string builder ─────────────────────────────────────────────────────

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== '',
  ) as [string, string | number | boolean][];

  if (entries.length === 0) return '';

  const qs = new URLSearchParams(
    entries.map(([k, v]) => [k, String(v)]),
  );

  return `?${qs.toString()}`;
}

// ─── Auth endpoints ───────────────────────────────────────────────────────────

/**
 * POST /auth/login
 * Stores the returned JWT and user record into localStorage on success.
 */
export async function login(body: LoginRequest): Promise<LoginResponse> {
  const res = await request<LoginResponse>('/auth/login', {
    method: 'POST',
    body,
    unauthenticated: true,
  });
  setToken(res.access_token);
  setCachedUser(res.user);
  return res;
}

/**
 * GET /auth/me
 * Fetches the current user profile and refreshes the localStorage cache.
 */
export async function getMe(): Promise<User> {
  const user = await request<User>('/auth/me');
  setCachedUser(user);
  return user;
}

/**
 * Sign out — clears the local token and user cache.
 * No server-side invalidation in the POC JWT implementation.
 */
export function logout(): void {
  clearToken();
}

// ─── Claims endpoints ─────────────────────────────────────────────────────────

/**
 * POST /claims
 * Create a new FNOL claim (standard agent channel).
 */
export async function createClaim(body: CreateClaimBody): Promise<Claim> {
  return request<Claim>('/claims', { method: 'POST', body });
}

/**
 * POST /claims/mobile
 * Mobile-app channel normaliser.
 */
export async function createClaimMobile(body: CreateClaimBody): Promise<Claim> {
  return request<Claim>('/claims/mobile', { method: 'POST', body });
}

/**
 * POST /claims/broker
 * Broker/dealer channel normaliser.
 */
export async function createClaimBroker(body: CreateClaimBody): Promise<Claim> {
  return request<Claim>('/claims/broker', { method: 'POST', body });
}

/**
 * POST /claims/email-parse
 * Email-parser channel; idempotent on Message-Id header.
 */
export async function createClaimEmail(
  body: CreateClaimBody,
  messageId?: string,
): Promise<Claim> {
  const headers: Record<string, string> = {};
  if (messageId) {
    headers['X-Message-Id'] = messageId;
  }
  return request<Claim>('/claims/email-parse', {
    method: 'POST',
    body,
    headers,
  });
}

/**
 * GET /claims
 * Role-scoped list of claims with optional filters.
 */
export async function listClaims(
  query: ClaimsListQuery = {},
): Promise<PaginatedResult<Claim>> {
  const qs = buildQuery(query as Record<string, string | number | boolean | undefined>);
  return request<PaginatedResult<Claim>>(`/claims${qs}`);
}

/**
 * GET /claims/:id
 * Role-masked claim detail.
 */
export async function getClaim(id: string): Promise<Claim> {
  return request<Claim>(`/claims/${id}`);
}

/**
 * POST /claims/:id/assign
 * Assign or reassign a claim adjuster (manager-only).
 */
export async function assignClaim(
  id: string,
  body: AssignClaimBody,
): Promise<Claim> {
  return request<Claim>(`/claims/${id}/assign`, { method: 'POST', body });
}

/**
 * POST /claims/:id/notes
 * Append an immutable note to a claim.
 */
export async function addNote(
  id: string,
  body: AddNoteBody,
): Promise<ClaimNote> {
  return request<ClaimNote>(`/claims/${id}/notes`, { method: 'POST', body });
}

/**
 * POST /claims/:id/evidence
 * Attach evidence (content-hash + blob ref) to a claim.
 */
export async function addEvidence(
  id: string,
  body: AddEvidenceBody,
): Promise<Evidence> {
  return request<Evidence>(`/claims/${id}/evidence`, { method: 'POST', body });
}

/**
 * POST /claims/:id/witness-statement
 * Record a structured witness statement including inkan_seal_hash.
 */
export async function addWitnessStatement(
  id: string,
  body: AddWitnessStatementBody,
): Promise<WitnessStatement> {
  return request<WitnessStatement>(`/claims/${id}/witness-statement`, {
    method: 'POST',
    body,
  });
}

/**
 * PATCH /claims/:id/status
 * Transition the claim through the workflow FSM.
 * Returns 422 if the transition is illegal.
 */
export async function updateClaimStatus(
  id: string,
  body: UpdateStatusBody,
): Promise<Claim> {
  return request<Claim>(`/claims/${id}/status`, { method: 'PATCH', body });
}

/**
 * GET /claims/:id/data-subject-export
 * APPI Article 28 — returns all PII the system holds about this individual.
 */
export async function getDataSubjectExport(
  id: string,
): Promise<DataSubjectExport> {
  return request<DataSubjectExport>(`/claims/${id}/data-subject-export`);
}

// ─── Reserves endpoints ───────────────────────────────────────────────────────

/**
 * POST /claims/:id/reserves
 * Propose a reserve change for a claim.
 */
export async function proposeReserve(
  claimId: string,
  body: ProposeReserveBody,
): Promise<Reserve> {
  return request<Reserve>(`/claims/${claimId}/reserves`, {
    method: 'POST',
    body,
  });
}

/**
 * GET /claims/:id/reserves
 * Full immutable reserve history for a claim.
 */
export async function listReserves(claimId: string): Promise<Reserve[]> {
  return request<Reserve[]>(`/claims/${claimId}/reserves`);
}

/**
 * POST /reserves/:id/approve
 * Manager approves a reserve (up to ¥10M).
 */
export async function approveReserve(reserveId: string): Promise<Reserve> {
  return request<Reserve>(`/reserves/${reserveId}/approve`, { method: 'POST' });
}

/**
 * POST /reserves/:id/director-approve
 * Claims-director approves a reserve >¥10M.
 */
export async function directorApproveReserve(reserveId: string): Promise<Reserve> {
  return request<Reserve>(`/reserves/${reserveId}/director-approve`, {
    method: 'POST',
  });
}

/**
 * POST /reserves/:id/reject
 * Manager rejects a reserve proposal.
 */
export async function rejectReserve(
  reserveId: string,
  body: RejectReserveBody,
): Promise<Reserve> {
  return request<Reserve>(`/reserves/${reserveId}/reject`, {
    method: 'POST',
    body,
  });
}

/**
 * GET /reserves/export?period=YYYY-MM
 * IFRS17-ready reserve aggregates for the actuarial pipeline.
 */
export async function exportReserves(
  query: ReservesExportQuery,
): Promise<ReservesExportRow[]> {
  const qs = buildQuery(query as Record<string, string | number | boolean | undefined>);
  return request<ReservesExportRow[]>(`/reserves/export${qs}`);
}

// ─── Audit endpoints ──────────────────────────────────────────────────────────

/**
 * GET /audit
 * Query the immutable audit log (auditor-only).
 */
export async function listAuditEvents(
  query: AuditListQuery = {},
): Promise<PaginatedResult<AuditEvent>> {
  const qs = buildQuery(query as Record<string, string | number | boolean | undefined>);
  return request<PaginatedResult<AuditEvent>>(`/audit${qs}`);
}

// ─── Notifications endpoints ──────────────────────────────────────────────────

/**
 * GET /notifications/jfsa-pending
 * Retrieve JFSA threshold notifications pending daily batch flush.
 * (Auditor-only.)
 */
export async function listJfsaPendingNotifications(): Promise<
  NotificationToRegulator[]
> {
  return request<NotificationToRegulator[]>('/notifications/jfsa-pending');
}

// ─── Convenience re-exports ───────────────────────────────────────────────────

/**
 * Thin namespace grouping all API functions for consumers that prefer a
 * single import:
 *
 *   import * as api from '@/lib/api';
 *   await api.login({ username, password });
 */
export const api = {
  // auth
  login,
  logout,
  getMe,
  // claims
  createClaim,
  createClaimMobile,
  createClaimBroker,
  createClaimEmail,
  listClaims,
  getClaim,
  assignClaim,
  addNote,
  addEvidence,
  addWitnessStatement,
  updateClaimStatus,
  getDataSubjectExport,
  // reserves
  proposeReserve,
  listReserves,
  approveReserve,
  directorApproveReserve,
  rejectReserve,
  exportReserves,
  // audit
  listAuditEvents,
  // notifications
  listJfsaPendingNotifications,
} as const;