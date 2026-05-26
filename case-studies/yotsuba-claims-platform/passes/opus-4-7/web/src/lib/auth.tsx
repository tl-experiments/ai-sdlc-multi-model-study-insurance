/**
 * Authentication context for the Yotsuba Adjuster Workbench.
 *
 * Why this module exists
 * ----------------------
 * The Workbench is a role-driven SPA. Every page either requires an
 * authenticated session (the queue, claim detail, reserve approvals,
 * audit log) or is the login page itself. Rather than re-implement the
 * "do I have a JWT? is it still valid? what role am I?" dance in every
 * component, this module exposes:
 *
 *   1. **An `AuthProvider`** that wraps the application (mounted in
 *      `App.tsx`). On mount it inspects `localStorage` via `lib/api.ts`,
 *      and if a token is present it calls `/auth/me` to materialise the
 *      `CurrentUser` record. A stale or rejected token is cleared so the
 *      provider settles into a clean unauthenticated state.
 *
 *   2. **A `useAuth()` hook** that returns the current session state
 *      (`status`, `user`, `token`) plus `login` / `logout` actions. The
 *      `status` discriminant (`'loading' | 'authenticated' | 'anonymous'`)
 *      is what pages branch on — most of them render a spinner while
 *      loading and redirect to `/login` while anonymous.
 *
 *   3. **A `RequireAuth` guard component** used by routed pages. It both
 *      enforces presence-of-session and, optionally, role membership —
 *      the role matrix in `brief.md` is the source of truth, and the
 *      `roles` prop maps directly onto it.
 *
 *   4. **A `RequireClaimsDirector` guard** for the one Workbench affordance
 *      (director-approve on a >¥10M reserve) where the gate is not the
 *      role but the `is_claims_director` boolean on the manager record.
 *
 * Design choices worth flagging:
 *
 *   - The provider owns *no* network logic of its own. All HTTP goes
 *     through `lib/api.ts`, so the auth context can be unit-tested by
 *     stubbing the exported `authApi` functions without spinning up a
 *     fetch mock.
 *
 *   - `ApiError.isUnauthorized` is what we listen for to decide whether
 *     a 401 mid-session means "token expired, log the user out". Other
 *     non-2xx codes are surfaced to the caller of `login()` so the
 *     `Login.tsx` page can render the message inline.
 *
 *   - The provider does *not* reach for `react-router-dom` itself —
 *     redirects on logout / 401 are the responsibility of the routed
 *     pages via `RequireAuth`. Keeping the provider router-agnostic
 *     means it composes cleanly under a `MemoryRouter` in tests.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  ApiError,
  authApi,
  getStoredToken,
  setStoredToken,
  type CurrentUser,
  type LoginPayload,
  type UserRole,
} from './api';

// ───────────────────────────── context shape ─────────────────────────────

/**
 * Tri-state lifecycle of the auth context.
 *
 * - `'loading'` — the provider has mounted but has not yet finished its
 *   initial `/auth/me` probe. Pages should render a neutral spinner.
 * - `'authenticated'` — `user` and `token` are populated and trusted.
 * - `'anonymous'` — no token, or the stored token was rejected. Pages
 *   under `RequireAuth` redirect to `/login`.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

/**
 * Public shape of the auth context. The provider exposes exactly this
 * surface; pages must not reach into `localStorage` or `authApi`
 * directly for session state.
 */
export interface AuthContextValue {
  /** Current lifecycle state. */
  readonly status: AuthStatus;
  /** The authenticated user, or `null` while loading / anonymous. */
  readonly user: CurrentUser | null;
  /** The raw JWT, or `null` while loading / anonymous. */
  readonly token: string | null;
  /**
   * Log in with the given credentials. Resolves on success; throws the
   * underlying `ApiError` on failure so the caller can render the message
   * inline (the `Login.tsx` page does exactly this).
   */
  login(payload: LoginPayload): Promise<CurrentUser>;
  /** Clear the session and revert to `'anonymous'`. Idempotent. */
  logout(): void;
  /**
   * Force a re-probe of `/auth/me`. Useful after a profile-affecting
   * mutation (e.g. a manager toggling `is_claims_director` on themselves,
   * which the Track B settings panel will support).
   */
  refresh(): Promise<void>;
  /**
   * Convenience predicate matching the role matrix in `brief.md`.
   * Returns `false` while the context is loading or anonymous.
   */
  hasRole(...roles: readonly UserRole[]): boolean;
  /**
   * `true` iff the current user is a manager flagged as a claims
   * director. Used to gate the director-approve action on reserves
   * over ¥10M.
   */
  readonly isClaimsDirector: boolean;
}

/**
 * Internal sentinel — `undefined` means "called outside a provider",
 * which is always a programmer error. The `useAuth` hook throws so the
 * mistake surfaces at first render instead of silently rendering a
 * broken page.
 */
const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ─────────────────────────── provider ────────────────────────────────────

export interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Top-level auth provider. Mounted once in `App.tsx`, above the router.
 *
 * Lifecycle:
 *   1. On mount, if a token is present in `localStorage`, transition to
 *      `'loading'` and probe `/auth/me`.
 *      - Success → `'authenticated'` with the returned user.
 *      - 401 → clear the token, transition to `'anonymous'`.
 *      - Network / 5xx → leave the token in place but transition to
 *        `'anonymous'` for the current render; the user can retry. We do
 *        *not* keep the provider stuck in `'loading'` because that would
 *        deadlock the routed pages behind `RequireAuth`.
 *   2. On `login()` success, persist the token and transition to
 *      `'authenticated'`.
 *   3. On `logout()`, clear the token and transition to `'anonymous'`.
 */
export function AuthProvider({ children }: AuthProviderProps): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>(() =>
    getStoredToken() ? 'loading' : 'anonymous',
  );
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [token, setToken] = useState<string | null>(() => getStoredToken());

  /**
   * StrictMode double-invokes effects in development. Without a guard,
   * the initial `/auth/me` probe would fire twice on mount, which is
   * harmless but noisy in the network panel. The ref makes the probe
   * idempotent across the second invocation.
   */
  const initialProbeStarted = useRef(false);

  const applyAuthenticated = useCallback((nextToken: string, nextUser: CurrentUser): void => {
    setStoredToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setStatus('authenticated');
  }, []);

  const applyAnonymous = useCallback((options: { clearStorage: boolean }): void => {
    if (options.clearStorage) {
      setStoredToken(null);
    }
    setToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const stored = getStoredToken();
    if (!stored) {
      applyAnonymous({ clearStorage: false });
      return;
    }
    setStatus('loading');
    try {
      const me = await authApi.me();
      setToken(stored);
      setUser(me);
      setStatus('authenticated');
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        // Stored token is no longer valid — wipe it so the next reload
        // does not re-trigger the same failing probe.
        applyAnonymous({ clearStorage: true });
        return;
      }
      // Network or 5xx: leave the token in place (the user may be
      // temporarily offline) but render as anonymous for now.
      applyAnonymous({ clearStorage: false });
    }
  }, [applyAnonymous]);

  useEffect(() => {
    if (initialProbeStarted.current) {
      return;
    }
    initialProbeStarted.current = true;

    const stored = getStoredToken();
    if (!stored) {
      // No token at boot → already in `'anonymous'` from the initial
      // state; nothing to do.
      return;
    }

    // Fire-and-forget; `refresh` handles all error paths internally.
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (payload: LoginPayload): Promise<CurrentUser> => {
      // We do not flip into `'loading'` here — `Login.tsx` already
      // renders its own submit-in-progress affordance, and toggling the
      // top-level status would unmount the login form mid-keystroke if
      // the page were re-keyed on `status`.
      const response = await authApi.login(payload);
      applyAuthenticated(response.access_token, response.user);
      return response.user;
    },
    [applyAuthenticated],
  );

  const logout = useCallback((): void => {
    applyAnonymous({ clearStorage: true });
  }, [applyAnonymous]);

  const hasRole = useCallback(
    (...roles: readonly UserRole[]): boolean => {
      if (status !== 'authenticated' || !user) {
        return false;
      }
      if (roles.length === 0) {
        return true;
      }
      return roles.includes(user.role);
    },
    [status, user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      token,
      login,
      logout,
      refresh,
      hasRole,
      isClaimsDirector:
        status === 'authenticated' && user !== null && user.is_claims_director === true,
    }),
    [status, user, token, login, logout, refresh, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─────────────────────────── hook ────────────────────────────────────────

/**
 * Access the current auth context. Throws if invoked outside an
 * `AuthProvider`, which is always a wiring bug — failing loudly at
 * first render is preferable to returning a degenerate value.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error(
      'useAuth() called outside <AuthProvider>. Wrap the app in <AuthProvider> in App.tsx.',
    );
  }
  return ctx;
}

// ─────────────────────────── route guards ────────────────────────────────

export interface RequireAuthProps {
  /**
   * If provided, the current user's role must be one of these for the
   * children to render. Mirrors the role matrix in `brief.md`.
   */
  roles?: readonly UserRole[];
  /**
   * Element rendered while the provider is still probing `/auth/me`.
   * Defaults to a neutral, accessible placeholder.
   */
  loadingFallback?: ReactNode;
  /**
   * Element rendered when the user is anonymous. The routed app passes
   * a `<Navigate to="/login" />` here; tests pass a sentinel.
   */
  unauthenticatedFallback?: ReactNode;
  /**
   * Element rendered when the user is authenticated but lacks the
   * required role. Defaults to a small inline banner so misuse surfaces
   * during development without crashing the page.
   */
  forbiddenFallback?: ReactNode;
  children: ReactNode;
}

/**
 * Default loading affordance. Lives here (rather than in a shared
 * component file) so the guard has no upstream dependencies beyond
 * React itself — handy for tests.
 */
function DefaultLoadingFallback(): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500"
    >
      Loading session…
    </div>
  );
}

function DefaultForbiddenFallback(): JSX.Element {
  return (
    <div
      role="alert"
      className="m-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
    >
      <p className="font-semibold">Access denied</p>
      <p className="mt-1">
        Your role does not have permission to view this page. If you believe this is a
        mistake, contact your claims-operations manager.
      </p>
    </div>
  );
}

function DefaultUnauthenticatedFallback(): JSX.Element {
  // We intentionally render *nothing* by default — the routed app is
  // expected to pass a real redirect element. Rendering a banner here
  // would briefly flash on every cold load before the redirect ran.
  return <></>;
}

/**
 * Gate a subtree on authentication (and optionally role membership).
 *
 * Usage in `App.tsx`:
 *
 *   <Route
 *     path="/claims"
 *     element={
 *       <RequireAuth
 *         roles={['adjuster', 'manager', 'auditor']}
 *         unauthenticatedFallback={<Navigate to="/login" replace />}
 *       >
 *         <ClaimQueue />
 *       </RequireAuth>
 *     }
 *   />
 */
export function RequireAuth({
  roles,
  loadingFallback,
  unauthenticatedFallback,
  forbiddenFallback,
  children,
}: RequireAuthProps): JSX.Element {
  const { status, user } = useAuth();

  if (status === 'loading') {
    return <>{loadingFallback ?? <DefaultLoadingFallback />}</>;
  }

  if (status === 'anonymous' || !user) {
    return <>{unauthenticatedFallback ?? <DefaultUnauthenticatedFallback />}</>;
  }

  if (roles && roles.length > 0 && !roles.includes(user.role)) {
    return <>{forbiddenFallback ?? <DefaultForbiddenFallback />}</>;
  }

  return <>{children}</>;
}

export interface RequireClaimsDirectorProps {
  forbiddenFallback?: ReactNode;
  loadingFallback?: ReactNode;
  unauthenticatedFallback?: ReactNode;
  children: ReactNode;
}

/**
 * Narrower guard for the one Workbench affordance — the
 * director-approve button on reserves over ¥10M — where the gate is
 * the `is_claims_director` boolean on the manager record rather than
 * a role per se. Implemented as a thin wrapper over `RequireAuth` so
 * the loading / unauthenticated branches stay consistent.
 */
export function RequireClaimsDirector({
  forbiddenFallback,
  loadingFallback,
  unauthenticatedFallback,
  children,
}: RequireClaimsDirectorProps): JSX.Element {
  const { isClaimsDirector } = useAuth();

  return (
    <RequireAuth
      roles={['manager']}
      loadingFallback={loadingFallback}
      unauthenticatedFallback={unauthenticatedFallback}
      forbiddenFallback={forbiddenFallback ?? <DefaultForbiddenFallback />}
    >
      {isClaimsDirector ? <>{children}</> : (forbiddenFallback ?? <DefaultForbiddenFallback />)}
    </RequireAuth>
  );
}