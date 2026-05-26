/**
 * auth.tsx
 *
 * React context + hook for authentication state management.
 *
 * Responsibilities:
 *  1. Provide the current authenticated user to the component tree via
 *     `AuthContext` / `useAuth` hook.
 *  2. Expose `login`, `logout`, and `refreshUser` actions.
 *  3. Restore session from localStorage on mount (so page refresh doesn't
 *     force re-login).
 *  4. Guard routes — `RequireAuth` wrapper redirects unauthenticated users
 *     to `/login`; `RequireRole` enforces RBAC at the route level.
 *  5. Never store raw passwords; only the JWT and cached user object.
 *
 * Design constraints:
 *  - Uses the api.ts `login`, `logout`, `getMe`, `getCachedUser` functions
 *    as the single source of truth for token storage.
 *  - UserRole enum mirrors Prisma / API exactly (no local redefinition).
 *  - Strict TypeScript; no `any`.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  login as apiLogin,
  logout as apiLogout,
  getMe,
  getCachedUser,
  setCachedUser,
  ApiError,
  type User,
  type UserRole,
  type LoginRequest,
} from './api';

// ─── Auth state ───────────────────────────────────────────────────────────────

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthState {
  /** The currently authenticated user, or null if unauthenticated. */
  user: User | null;
  /** Lifecycle status — 'loading' while restoring session from localStorage. */
  status: AuthStatus;
}

// ─── Context value shape ──────────────────────────────────────────────────────

export interface AuthContextValue extends AuthState {
  /**
   * Attempt to authenticate with the given credentials.
   * On success, stores the JWT + user in localStorage and updates state.
   * On failure, throws an `ApiError` so the Login page can display the message.
   */
  login: (credentials: LoginRequest) => Promise<void>;

  /**
   * Sign out the current user — clears localStorage and resets state.
   */
  logout: () => void;

  /**
   * Re-fetch the current user from `GET /auth/me` and refresh the cache.
   * Useful after role changes or profile updates.
   */
  refreshUser: () => Promise<void>;

  /**
   * Convenience: true when `status === 'authenticated'` and `user !== null`.
   */
  isAuthenticated: boolean;

  /**
   * Convenience: true while the session restore check is in-flight.
   */
  isLoading: boolean;

  /**
   * Returns true if the current user has at least one of the given roles.
   * Always returns false when unauthenticated.
   */
  hasRole: (...roles: UserRole[]) => boolean;

  /**
   * Returns true if the current user is a claims director
   * (manager role + `is_claims_director === true`).
   */
  isClaimsDirector: boolean;
}

// ─── Context ──────────────────────────────────────────────────────────────────

/**
 * AuthContext — do not consume directly; use `useAuth()` instead so the
 * missing-provider error is human-readable.
 */
const AuthContext = createContext<AuthContextValue | null>(null);
AuthContext.displayName = 'AuthContext';

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * `<AuthProvider>` — mount once at the application root (above the router).
 *
 * On mount it checks localStorage for a cached user + JWT and, if found,
 * silently re-validates against `GET /auth/me`.  If the server rejects the
 * token (401), the cached session is cleared and the user is shown as
 * unauthenticated.
 */
export function AuthProvider({ children }: AuthProviderProps): React.ReactElement {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // ── Session restore on mount ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function restoreSession(): Promise<void> {
      // First, check for a cached user — gives instant paint without a
      // network round-trip.
      const cached = getCachedUser();

      if (!cached) {
        // No cached session at all — go straight to unauthenticated.
        if (!cancelled) setStatus('unauthenticated');
        return;
      }

      // Optimistically show the cached user while we validate the token.
      if (!cancelled) {
        setUser(cached);
        setStatus('authenticated');
      }

      // Silently validate against the server to detect token expiry.
      try {
        const fresh = await getMe();
        if (!cancelled) {
          setUser(fresh);
          setCachedUser(fresh);
          setStatus('authenticated');
        }
      } catch (err) {
        if (!cancelled) {
          // Token invalid or expired — clear the stale session.
          apiLogout();
          setUser(null);
          setStatus('unauthenticated');
        }
        // Suppress the error — this is a silent background check.
        void err;
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── login action ────────────────────────────────────────────────────────
  const login = useCallback(async (credentials: LoginRequest): Promise<void> => {
    // apiLogin handles token + user persistence in localStorage.
    const res = await apiLogin(credentials);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  // ── logout action ───────────────────────────────────────────────────────
  const logout = useCallback((): void => {
    apiLogout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  // ── refreshUser action ──────────────────────────────────────────────────
  const refreshUser = useCallback(async (): Promise<void> => {
    try {
      const fresh = await getMe();
      setUser(fresh);
      setCachedUser(fresh);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Token has expired mid-session.
        apiLogout();
        setUser(null);
        setStatus('unauthenticated');
      }
      throw err;
    }
  }, []);

  // ── Derived booleans ────────────────────────────────────────────────────
  const isAuthenticated = status === 'authenticated' && user !== null;
  const isLoading = status === 'loading';
  const isClaimsDirector =
    isAuthenticated && user?.role === 'manager' && (user?.is_claims_director ?? false);

  const hasRole = useCallback(
    (...roles: UserRole[]): boolean => {
      if (!user) return false;
      return roles.includes(user.role);
    },
    [user],
  );

  // ── Context value (memoised to avoid unnecessary re-renders) ────────────
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login,
      logout,
      refreshUser,
      isAuthenticated,
      isLoading,
      hasRole,
      isClaimsDirector,
    }),
    [
      user,
      status,
      login,
      logout,
      refreshUser,
      isAuthenticated,
      isLoading,
      hasRole,
      isClaimsDirector,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── useAuth hook ─────────────────────────────────────────────────────────────

/**
 * `useAuth()` — primary hook for reading auth state and dispatching auth
 * actions in any component below `<AuthProvider>`.
 *
 * @throws Error if called outside of an `<AuthProvider>`.
 *
 * @example
 * ```tsx
 * const { user, isAuthenticated, login, logout, hasRole } = useAuth();
 * ```
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error(
      'useAuth() must be called inside an <AuthProvider>. ' +
        'Ensure <AuthProvider> is mounted at the application root.',
    );
  }
  return ctx;
}

// ─── Route guard components ───────────────────────────────────────────────────

export interface RequireAuthProps {
  children: React.ReactNode;
  /**
   * Component to render while the session restore is in-flight.
   * Defaults to a full-screen spinner.
   */
  fallbackLoading?: React.ReactNode;
  /**
   * Component to render when the user is not authenticated.
   * Defaults to a redirect instruction element — callers using React Router
   * should pass `<Navigate to="/login" replace />` here.
   */
  fallbackUnauthenticated?: React.ReactNode;
}

/**
 * `<RequireAuth>` — wraps a route tree and prevents unauthenticated access.
 *
 * Usage with React Router v6:
 * ```tsx
 * <Route
 *   path="/claims"
 *   element={
 *     <RequireAuth fallbackUnauthenticated={<Navigate to="/login" replace />}>
 *       <ClaimQueue />
 *     </RequireAuth>
 *   }
 * />
 * ```
 */
export function RequireAuth({
  children,
  fallbackLoading,
  fallbackUnauthenticated,
}: RequireAuthProps): React.ReactElement {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <>
        {fallbackLoading ?? (
          <div className="flex h-full items-center justify-center bg-gray-50">
            <span className="h-8 w-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin-fast" />
          </div>
        )}
      </>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <>
        {fallbackUnauthenticated ?? (
          <div className="flex h-full items-center justify-center bg-gray-50">
            <p className="text-sm text-gray-500">
              You must be signed in to view this page.
            </p>
          </div>
        )}
      </>
    );
  }

  return <>{children}</>;
}

export interface RequireRoleProps {
  /** One or more roles that are permitted to access the wrapped content. */
  roles: UserRole[];
  children: React.ReactNode;
  /**
   * Component to render when the user's role is not in `roles`.
   * Defaults to a generic 403 message.
   */
  fallback?: React.ReactNode;
}

/**
 * `<RequireRole>` — renders `children` only if the current user has one of
 * the allowed `roles`.  Must be used inside `<RequireAuth>` (and therefore
 * inside `<AuthProvider>`).
 *
 * @example
 * ```tsx
 * <RequireRole roles={['manager', 'auditor']}>
 *   <ReserveApprovals />
 * </RequireRole>
 * ```
 */
export function RequireRole({
  roles,
  children,
  fallback,
}: RequireRoleProps): React.ReactElement {
  const { hasRole, isAuthenticated } = useAuth();

  if (!isAuthenticated || !hasRole(...roles)) {
    return (
      <>
        {fallback ?? (
          <div className="flex h-full items-center justify-center bg-gray-50">
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-700">Access Denied</p>
              <p className="mt-1 text-sm text-gray-500">
                You do not have permission to view this page.
              </p>
            </div>
          </div>
        )}
      </>
    );
  }

  return <>{children}</>;
}

// ─── Convenience re-exports ───────────────────────────────────────────────────

/**
 * Re-export the User type so consumers can import from a single location.
 */
export type { User, UserRole };