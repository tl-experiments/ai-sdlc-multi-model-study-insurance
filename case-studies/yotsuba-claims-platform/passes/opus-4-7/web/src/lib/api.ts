/**
 * HTTP client for the Yotsuba Adjuster Workbench.
 *
 * Why this module exists
 * ----------------------
 * Every page in the Workbench talks to the NestJS backend documented in
 * `design.md` §2. Rather than scatter `fetch` calls across components, this
 * file centralises:
 *
 *   1. **Base URL resolution.** Vite's `import.meta.env.VITE_API_BASE_URL`
 *      is the canonical override; otherwise we default to the same origin
 *      the SPA is served from, which is how the dev proxy in `vite.config.ts`
 *      is wired.
 *
 *   2. **JWT attachment.** The token is owned by `lib/auth.tsx` and stored
 *      in `localStorage` under a single key (`yotsuba.workbench.jwt`). This
 *      module exposes thin getters / setters so the auth context and the
 *      request layer agree on exactly one key — drift between the two has
 *      historically been a source of silent 401s.
 *
 *   3. **Error envelope normalisation.** The backend's global exception
 *      filter (see `src/common/error.filter.ts`) emits a stable JSON shape:
 *      `{ statusCode, message, error, request_id?, correlation_id? }`. The
 *      Workbench surfaces these via the `ApiError` class so callers can
 *      pattern-match on `status` (for 401 → re-login, 422 → form errors,
 *      etc.) without re-parsing the body.
 *
 *   4. **Correlation-id propagation.** Every outbound request carries an
 *      `X-Correlation-Id` header (a fresh UUID per request). The backend
 *      audit interceptor binds that id to every `AuditEvent` produced by
 *      the request, which is the mechanism `design.md` §6 relies on for
 *      end-to-end traceability. We also surface the server-assigned
 *      `request_id` back on `ApiError` so support staff can grep the logs.
 *
 *   5. **Typed resource helpers.** Each Track A endpoint listed in
 *      `design.md` §2 has a matching function here, returning a typed
 *      response. The types live in this file (rather than a separate
 *      `types.ts`) so a reader can see request shape, response shape, and
 *      URL in one place — which is what reviewers asked for during the
 *      Phase 1 walkthrough.
 *
 * This module is deliberately framework-agnostic (no React imports). The
 * auth context wraps these helpers with hooks; pages call the wrapped
 * versions. That separation keeps the API client unit-testable without
 * spinning up a renderer.
 */

// ───────────────────────────── configuration ─────────────────────────────

/**
 * Single storage key for the JWT. The auth context (`lib/auth.tsx`) reads
 * and writes through `getStoredToken` / `setStoredToken` exposed below;
 * raw access to `localStorage` from elsewhere in the codebase is a smell.
 */
const TOKEN_STORAGE_KEY = 'yotsuba.workbench.jwt';

/**
 * Resolve the API base URL.
 *
 * Priority order:
 *   1. `VITE_API_BASE_URL` env (set in `.env.local` for dev, in the build
 *      pipeline for staging/prod).
 *   2. Empty string → use same-origin paths, which lets the Vite dev proxy
 *      (configured in `vite.config.ts`) forward `/auth/*`, `/claims/*`,
 *      etc. to `http://localhost:3000` without a CORS preflight.
 */
function resolveBaseUrl(): string {
  const fromEnv = (import.meta.env.VITE_API_BASE_URL ?? '').toString().trim();
  if (fromEnv.length === 0) {
    return '';
  }
  // Strip a single trailing slash so callers can write `${BASE}/claims`.
  return fromEnv.endsWith('/') ? fromEnv.slice(0, -1) : fromEnv;
}

const API_BASE_URL = resolveBaseUrl();

// ───────────────────────────── token storage ─────────────────────────────

/**
 * Read the JWT from `localStorage`. Returns `null` if nothing is stored or
 * if `localStorage` is unavailable (e.g. SSR, sandboxed iframe).
 */
export function getStoredToken(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the JWT to `localStorage`. Passing `null` clears it — used by
 * `logout()` in the auth context.
 */
export function setStoredToken(token: string | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    if (token === null) {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Swallow storage errors silently — the worst case is that the user has
    // to re-login on next reload, which is acceptable.
  }
}

// ─────────────────────────── error normalisation ─────────────────────────

/**
 * Stable error envelope emitted by the backend's global exception filter.
 */
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  error?: string;
  request_id?: string;
  correlation_id?: string;
}

/**
 * Typed error thrown by `request()` for any non-2xx response. Pages catch
 * this and pattern-match on `status` to decide whether to surface a form
 * error (422), redirect to login (401), show a permission-denied banner
 * (403), etc.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly body: ApiErrorBody | null;
  public readonly requestId: string | null;
  public readonly correlationId: string | null;

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    const rawMessage = body?.message ?? fallbackMessage;
    const flatMessage = Array.isArray(rawMessage) ? rawMessage.join('; ') : rawMessage;
    super(flatMessage);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.requestId = body?.request_id ?? null;
    this.correlationId = body?.correlation_id ?? null;
  }

  /**
   * Convenience predicate for the common 401 case (token missing / expired).
   * The auth context uses this to trigger a redirect to `/login`.
   */
  public get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * 403 — the user is authenticated but the role matrix denied the action.
   * Pages render an inline banner rather than redirecting.
   */
  public get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * 422 — validation or state-machine refusal. The backend's FSM
   * (`claims-status.fsm.ts`) and the reserve-approval rules both surface
   * here; the page shows the message verbatim.
   */
  public get isValidation(): boolean {
    return this.status === 422 || this.status === 400;
  }
}

// ─────────────────────────── correlation ids ─────────────────────────────

/**
 * Generate a fresh correlation id for an outbound request. We prefer the
 * browser's `crypto.randomUUID()` (available in all evergreen targets);
 * the fallback is a v4-shaped hex string that is *not* cryptographically
 * strong but is good enough to disambiguate concurrent requests in logs.
 */
function newCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122-shaped fallback. Sufficient for log correlation; not used for
  // any security-sensitive purpose.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

// ───────────────────────────── core request ──────────────────────────────

/**
 * HTTP method discriminant — narrower than the global `string` so callers
 * cannot typo `'PSOT'`.
 */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Options accepted by the `request<T>` core helper.
 */
export interface RequestOptions {
  /** Query-string parameters. `undefined` / `null` values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON-serialisable request body. Sent only for non-GET methods. */
  body?: unknown;
  /** AbortSignal for cancellation (used by ClaimQueue's filter debounce). */
  signal?: AbortSignal;
  /**
   * Override the stored JWT for this single call. Mostly useful in tests;
   * production code lets the helper read from `localStorage`.
   */
  token?: string | null;
  /**
   * If `true`, the response is parsed as text instead of JSON. Used by
   * `/reserves/export` when the backend returns NDJSON.
   */
  asText?: boolean;
}

/**
 * Build a fully-qualified URL given a path and optional query parameters.
 */
function buildUrl(path: string, query?: RequestOptions['query']): string {
  const prefix = path.startsWith('/') ? '' : '/';
  let url = `${API_BASE_URL}${prefix}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs.length > 0) {
      url += (url.includes('?') ? '&' : '?') + qs;
    }
  }
  return url;
}

/**
 * Parse a response body, tolerating an empty payload (e.g. 204 No Content
 * or a `PATCH` that returns nothing).
 */
async function parseResponseBody(response: Response, asText: boolean): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  const raw = await response.text();
  if (raw.length === 0) {
    return null;
  }
  if (asText) {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Non-JSON body on a 2xx is unexpected but not fatal — surface the raw
    // text so the caller can decide.
    return raw;
  }
}

/**
 * Core request helper. Every typed function below funnels through here.
 */
export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(path, options.query);
  const correlationId = newCorrelationId();

  const headers: Record<string, string> = {
    Accept: options.asText ? 'text/plain, application/json' : 'application/json',
    'X-Correlation-Id': correlationId,
  };

  const token = options.token === undefined ? getStoredToken() : options.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined && method !== 'GET') {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: options.signal,
      // The workbench is same-origin in dev (via proxy) and same-origin in
      // prod (served behind the same load balancer); `credentials: 'omit'`
      // is the safe default because auth flows through the bearer header.
      credentials: 'omit',
    });
  } catch (err) {
    // Network-level failure (DNS, offline, CORS preflight rejection, etc.).
    // Surface it as an `ApiError` with status 0 so callers have one error
    // type to handle.
    if ((err as { name?: string }).name === 'AbortError') {
      throw err;
    }
    const message =
      err instanceof Error ? err.message : 'Network request failed';
    throw new ApiError(0, null, message);
  }

  if (!response.ok) {
    const parsed = (await parseResponseBody(response, false)) as ApiErrorBody | string | null;
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as ApiErrorBody) : null;
    throw new ApiError(
      response.status,
      body,
      typeof parsed === 'string' && parsed.length > 0
        ? parsed
        : `Request failed with status ${response.status}`,
    );
  }

  const parsed = await parseResponseBody(response, options.asText === true);
  return parsed as T;
}

// ─────────────────────────── domain typings ──────────────────────────────
//
// These mirror the Prisma enums in `prisma/schema.prisma` and the response
// shapes in `design.md` §2. They are intentionally hand-written (rather
// than generated) so reviewers can read the contract in one place.

export type UserRole = 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';

export type IntakeChannel = 'agent' | 'mobile' | 'broker' | 'email';

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

export type ReserveCategory = 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type EvidenceKind =
  | 'photo'
  | 'document'
  | 'audio'
  | 'video'
  | 'witness_statement_attachment';

/**
 * Authenticated user shape returned by `/auth/me`.
 */
export interface CurrentUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: UserRole;
  is_claims_director: boolean;
  reports_to_id: string | null;
}

export interface LoginResponse {
  access_token: string;
  role: UserRole;
  user: CurrentUser;
}

/**
 * Claim list-row shape. The backend masks PII per the role matrix before
 * sending; the field types stay nullable to reflect that.
 */
export interface ClaimSummary {
  id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  reported_by_channel: IntakeChannel;
  incident_type: IncidentType;
  severity_initial: ClaimSeverity;
  status: ClaimStatus;
  assigned_adjuster_id: string | null;
  assigned_adjuster_name: string | null;
  reporter_name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Detail shape. Adds the nested collections rendered in `ClaimDetail.tsx`.
 */
export interface ClaimDetail extends ClaimSummary {
  loss_location_postal_code: string;
  loss_location_detail: string;
  reporter_phone: string | null;
  reporter_email: string | null;
  reporter_relation_to_insured: string;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number: string | null;
  appi_consent_version: string;
  appi_consent_at: string;
  notes: ClaimNote[];
  evidence: EvidenceItem[];
  witness_statements: WitnessStatementItem[];
  reserves: ReserveItem[];
}

export interface ClaimNote {
  id: string;
  claim_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface EvidenceItem {
  id: string;
  claim_id: string;
  kind: EvidenceKind;
  content_hash: string;
  blob_ref: string;
  uploaded_by_id: string;
  uploaded_at: string;
}

export interface WitnessStatementItem {
  id: string;
  claim_id: string;
  witness_name: string;
  witness_phone: string | null;
  statement_body: string;
  inkan_seal_hash: string;
  recorded_by_id: string;
  recorded_at: string;
}

export interface ReserveItem {
  id: string;
  claim_id: string;
  category: ReserveCategory;
  proposed_yen: string;
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

export interface AuditEventItem {
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

export interface JfsaNotificationItem {
  id: string;
  kind: string;
  claim_id: string;
  reserve_id: string;
  amount_yen: string;
  triggered_at: string;
  sent_at: string | null;
}

// ─────────────────────────── request payloads ────────────────────────────

export interface LoginPayload {
  username: string;
  password: string;
}

export interface CreateClaimPayload {
  policy_number: string;
  loss_date: string;
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
  injury_reported?: boolean;
  third_party_involved?: boolean;
  police_report_number?: string;
  appi_consent_version: string;
  appi_consent_at: string;
}

export interface ClaimListQuery {
  status?: ClaimStatus;
  severity?: ClaimSeverity;
  channel?: IntakeChannel;
  assignee?: string;
  ageDays?: number;
}

export interface AssignClaimPayload {
  adjuster_id: string;
  reason_for_reassignment?: string;
}

export interface AddNotePayload {
  body: string;
}

export interface AddEvidencePayload {
  kind: EvidenceKind;
  content_hash: string;
  blob_ref: string;
}

export interface AddWitnessStatementPayload {
  witness_name: string;
  witness_phone?: string;
  statement_body: string;
  inkan_seal_hash: string;
}

export interface UpdateStatusPayload {
  to: ClaimStatus;
  reason: string;
}

export interface ProposeReservePayload {
  category: ReserveCategory;
  proposed_yen: string | number;
  justification: string;
}

export interface RejectReservePayload {
  reason_for_rejection: string;
}

export interface AuditQuery {
  from?: string;
  to?: string;
  actor?: string;
  claim_id?: string;
  action?: string;
}

export interface ReserveExportRow {
  period: string;
  category: ReserveCategory;
  total_yen: string;
  reserve_count: number;
}

// ───────────────────────────── auth helpers ──────────────────────────────

export const authApi = {
  login(payload: LoginPayload): Promise<LoginResponse> {
    // `/auth/login` is the one endpoint that must NOT carry a stale token —
    // explicitly pass `null` to suppress the Authorization header.
    return request<LoginResponse>('POST', '/auth/login', { body: payload, token: null });
  },

  me(): Promise<CurrentUser> {
    return request<CurrentUser>('GET', '/auth/me');
  },
};

// ─────────────────────────── claims helpers ──────────────────────────────

export const claimsApi = {
  list(query: ClaimListQuery = {}): Promise<ClaimSummary[]> {
    return request<ClaimSummary[]>('GET', '/claims', { query });
  },

  get(id: string): Promise<ClaimDetail> {
    return request<ClaimDetail>('GET', `/claims/${encodeURIComponent(id)}`);
  },

  create(payload: CreateClaimPayload): Promise<ClaimDetail> {
    return request<ClaimDetail>('POST', '/claims', { body: payload });
  },

  createMobile(payload: CreateClaimPayload): Promise<ClaimDetail> {
    return request<ClaimDetail>('POST', '/claims/mobile', { body: payload });
  },

  createBroker(payload: CreateClaimPayload): Promise<ClaimDetail> {
    return request<ClaimDetail>('POST', '/claims/broker', { body: payload });
  },

  createFromEmail(payload: CreateClaimPayload & { message_id: string }): Promise<ClaimDetail> {
    return request<ClaimDetail>('POST', '/claims/email-parse', { body: payload });
  },

  assign(id: string, payload: AssignClaimPayload): Promise<ClaimDetail> {
    return request<ClaimDetail>('POST', `/claims/${encodeURIComponent(id)}/assign`, {
      body: payload,
    });
  },

  addNote(id: string, payload: AddNotePayload): Promise<ClaimNote> {
    return request<ClaimNote>('POST', `/claims/${encodeURIComponent(id)}/notes`, {
      body: payload,
    });
  },

  addEvidence(id: string, payload: AddEvidencePayload): Promise<EvidenceItem> {
    return request<EvidenceItem>('POST', `/claims/${encodeURIComponent(id)}/evidence`, {
      body: payload,
    });
  },

  addWitnessStatement(
    id: string,
    payload: AddWitnessStatementPayload,
  ): Promise<WitnessStatementItem> {
    return request<WitnessStatementItem>(
      'POST',
      `/claims/${encodeURIComponent(id)}/witness-statement`,
      { body: payload },
    );
  },

  updateStatus(id: string, payload: UpdateStatusPayload): Promise<ClaimDetail> {
    return request<ClaimDetail>('PATCH', `/claims/${encodeURIComponent(id)}/status`, {
      body: payload,
    });
  },

  dataSubjectExport(id: string): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(
      'GET',
      `/claims/${encodeURIComponent(id)}/data-subject-export`,
    );
  },

  listReserves(id: string): Promise<ReserveItem[]> {
    return request<ReserveItem[]>('GET', `/claims/${encodeURIComponent(id)}/reserves`);
  },

  proposeReserve(id: string, payload: ProposeReservePayload): Promise<ReserveItem> {
    return request<ReserveItem>('POST', `/claims/${encodeURIComponent(id)}/reserves`, {
      body: payload,
    });
  },
};

// ─────────────────────────── reserves helpers ────────────────────────────

export const reservesApi = {
  approve(id: string): Promise<ReserveItem> {
    return request<ReserveItem>('POST', `/reserves/${encodeURIComponent(id)}/approve`);
  },

  directorApprove(id: string): Promise<ReserveItem> {
    return request<ReserveItem>(
      'POST',
      `/reserves/${encodeURIComponent(id)}/director-approve`,
    );
  },

  reject(id: string, payload: RejectReservePayload): Promise<ReserveItem> {
    return request<ReserveItem>('POST', `/reserves/${encodeURIComponent(id)}/reject`, {
      body: payload,
    });
  },

  export(period: string): Promise<ReserveExportRow[]> {
    return request<ReserveExportRow[]>('GET', '/reserves/export', { query: { period } });
  },
};

// ───────────────────────────── audit helpers ─────────────────────────────

export const auditApi = {
  list(query: AuditQuery = {}): Promise<AuditEventItem[]> {
    return request<AuditEventItem[]>('GET', '/audit', { query });
  },
};

// ─────────────────────── notifications helpers ───────────────────────────

export const notificationsApi = {
  jfsaPending(): Promise<JfsaNotificationItem[]> {
    return request<JfsaNotificationItem[]>('GET', '/notifications/jfsa-pending');
  },
};

// ────────────────────────── default export ───────────────────────────────

/**
 * Convenience aggregate so pages can write `import api from '../lib/api'`
 * and reach every resource through a single namespace. Individual named
 * exports above remain the preferred form for tree-shaking.
 */
const api = {
  auth: authApi,
  claims: claimsApi,
  reserves: reservesApi,
  audit: auditApi,
  notifications: notificationsApi,
  request,
  ApiError,
  getStoredToken,
  setStoredToken,
} as const;

export default api;