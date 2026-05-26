/**
 * api.ts
 * HTTP client for the Yotsuba Claims Processing Platform.
 * Handles JWT authentication, request/response serialization, error handling,
 * and correlation ID propagation.
 */

import { formatYen } from './format-yen';

/**
 * API response envelope — all endpoints return this shape.
 */
export interface ApiResponse<T = unknown> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: {
    request_id: string;
    correlation_id: string;
  };
}

/**
 * Claim detail response shape.
 */
export interface ClaimDetail {
  id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reported_by_channel: 'agent' | 'mobile' | 'broker' | 'email';
  reporter_name: string;
  reporter_phone?: string; // masked based on role
  reporter_email?: string; // masked based on role
  reporter_relation_to_insured: string;
  incident_type: string;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number?: string;
  severity_initial: 'simple' | 'complex' | 'catastrophic';
  status: string;
  appi_consent_version: string;
  appi_consent_at: string;
  assigned_adjuster_id?: string;
  assigned_adjuster?: {
    id: string;
    display_name: string;
    email: string;
  };
  created_at: string;
  updated_at: string;
  notes?: ClaimNote[];
  evidence?: Evidence[];
  witness_statements?: WitnessStatement[];
  reserves?: Reserve[];
}

/**
 * Claim note (immutable append-only).
 */
export interface ClaimNote {
  id: string;
  claim_id: string;
  author_id: string;
  author?: {
    id: string;
    display_name: string;
  };
  body: string;
  created_at: string;
}

/**
 * Evidence attachment.
 */
export interface Evidence {
  id: string;
  claim_id: string;
  kind: 'photo' | 'document' | 'audio' | 'video' | 'witness_statement_attachment';
  content_hash: string;
  blob_ref: string;
  uploaded_by_id: string;
  uploaded_at: string;
}

/**
 * Witness statement.
 */
export interface WitnessStatement {
  id: string;
  claim_id: string;
  witness_name: string;
  witness_phone?: string; // masked based on role
  statement_body: string;
  inkan_seal_hash: string;
  recorded_by_id: string;
  recorded_at: string;
}

/**
 * Reserve record.
 */
export interface Reserve {
  id: string;
  claim_id: string;
  category: 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae';
  proposed_yen: string; // Decimal as string
  prior_yen?: string;
  justification: string;
  proposed_by_id: string;
  proposed_at: string;
  approval_status: 'pending' | 'approved' | 'rejected';
  approved_by_id?: string;
  approved_at?: string;
  director_approved_by_id?: string;
  director_approved_at?: string;
  reason_for_rejection?: string;
}

/**
 * Claim list item (summary).
 */
export interface ClaimListItem {
  id: string;
  policy_number: string;
  loss_date: string;
  incident_type: string;
  severity_initial: 'simple' | 'complex' | 'catastrophic';
  status: string;
  reported_by_channel: string;
  assigned_adjuster_id?: string;
  assigned_adjuster?: {
    id: string;
    display_name: string;
  };
  created_at: string;
}

/**
 * Auth response.
 */
export interface AuthResponse {
  access_token: string;
  role: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
  user: {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: string;
    is_claims_director?: boolean;
  };
}

/**
 * Current user info.
 */
export interface CurrentUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
  is_claims_director?: boolean;
}

/**
 * API client class — singleton managing JWT, requests, and error handling.
 */
class ApiClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private currentUser: CurrentUser | null = null;

  constructor(baseUrl: string = import.meta.env["VITE_API_URL"] || 'http://localhost:3000') {
    this.baseUrl = baseUrl;
    this.loadTokenFromStorage();
  }

  /**
   * Load JWT from localStorage if available.
   */
  private loadTokenFromStorage(): void {
    const token = localStorage.getItem('access_token');
    const user = localStorage.getItem('current_user');
    if (token) {
      this.accessToken = token;
    }
    if (user) {
      try {
        this.currentUser = JSON.parse(user);
      } catch {
        // Ignore parse errors
      }
    }
  }

  /**
   * Save JWT and user to localStorage.
   */
  private saveTokenToStorage(): void {
    if (this.accessToken) {
      localStorage.setItem('access_token', this.accessToken);
    }
    if (this.currentUser) {
      localStorage.setItem('current_user', JSON.stringify(this.currentUser));
    }
  }

  /**
   * Clear stored credentials.
   */
  private clearTokenFromStorage(): void {
    localStorage.removeItem('access_token');
    localStorage.removeItem('current_user');
    this.accessToken = null;
    this.currentUser = null;
  }

  /**
   * Get the current access token.
   */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Get the current user.
   */
  getCurrentUser(): CurrentUser | null {
    return this.currentUser;
  }

  /**
   * Check if user is authenticated.
   */
  isAuthenticated(): boolean {
    return this.accessToken !== null && this.currentUser !== null;
  }

  /**
   * Check if user has a specific role.
   */
  hasRole(role: string): boolean {
    return this.currentUser?.role === role;
  }

  /**
   * Check if user is claims director.
   */
  isClaimsDirector(): boolean {
    return this.currentUser?.is_claims_director === true;
  }

  /**
   * Perform login and store JWT.
   */
  async login(username: string, password: string): Promise<AuthResponse> {
    const response = await this.post<AuthResponse>('/auth/login', {
      username,
      password,
    });

    this.accessToken = response.access_token;
    this.currentUser = response.user as CurrentUser;
    this.saveTokenToStorage();

    return response;
  }

  /**
   * Logout and clear stored credentials.
   */
  logout(): void {
    this.clearTokenFromStorage();
  }

  /**
   * Fetch current user info.
   */
  async fetchCurrentUser(): Promise<CurrentUser> {
    const user = await this.get<CurrentUser>('/auth/me');
    this.currentUser = user;
    this.saveTokenToStorage();
    return user;
  }

  /**
   * Generic GET request.
   */
  async get<T = unknown>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  /**
   * Generic POST request.
   */
  async post<T = unknown>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Generic PATCH request.
   */
  async patch<T = unknown>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Generic DELETE request.
   */
  async delete<T = unknown>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Core request handler with JWT injection, error handling, and correlation ID.
   */
  private async request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers || {});

    // Inject JWT if available
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }

    // Ensure Content-Type for JSON
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Generate or propagate correlation ID
    const correlationId = this.getOrGenerateCorrelationId();
    headers.set('X-Correlation-ID', correlationId);

    const response = await fetch(url, {
      ...options,
      headers,
    });

    // Handle non-2xx responses
    if (!response.ok) {
      const errorData = await this.parseErrorResponse(response);
      throw new ApiError(
        errorData.message || `HTTP ${response.status}`,
        response.status,
        errorData.code,
        errorData.details
      );
    }

    // Parse response
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const json = await response.json();
      // If response is wrapped in ApiResponse envelope, unwrap it
      if (json.data !== undefined) {
        return json.data as T;
      }
      return json as T;
    }

    return null as T;
  }

  /**
   * Parse error response from API.
   */
  private async parseErrorResponse(
    response: Response
  ): Promise<{ message: string; code?: string; details?: Record<string, unknown> }> {
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      try {
        const json = await response.json();
        if (json.error) {
          return json.error;
        }
        return json;
      } catch {
        return { message: response.statusText };
      }
    }
    return { message: response.statusText };
  }

  /**
   * Get or generate a correlation ID for request tracing.
   */
  private getOrGenerateCorrelationId(): string {
    // Check if already set in sessionStorage
    let correlationId = sessionStorage.getItem('correlation_id');
    if (!correlationId) {
      correlationId = this.generateUuid();
      sessionStorage.setItem('correlation_id', correlationId);
    }
    return correlationId;
  }

  /**
   * Generate a UUID v4.
   */
  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/**
 * Custom error class for API errors.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Singleton instance of the API client.
 */
let apiClientInstance: ApiClient | null = null;

/**
 * Get or create the singleton API client.
 */
export function getApiClient(): ApiClient {
  if (!apiClientInstance) {
    apiClientInstance = new ApiClient();
  }
  return apiClientInstance;
}

/**
 * Reset the API client (useful for testing).
 */
export function resetApiClient(): void {
  apiClientInstance = null;
}

/**
 * Hook-like function to use the API client in components.
 */
export function useApi(): ApiClient {
  return getApiClient();
}