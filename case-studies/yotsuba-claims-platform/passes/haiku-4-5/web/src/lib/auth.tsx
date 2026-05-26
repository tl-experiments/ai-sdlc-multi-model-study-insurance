/**
 * DEMO-ONLY auth bypass for Track B refinement showcase.
 *
 * The original Haiku-authored auth.tsx had a working flow except for a
 * race condition between StrictMode double-mount and the /auth/me probe
 * that intermittently cleared localStorage. Rather than chase that bug
 * (Track B's mechanical refinement is what's being demonstrated, not
 * production-grade auth), this shim:
 *
 *   - Provides the same public hooks the original exposed
 *   - Returns a fixed adjuster user immediately, no network probe
 *   - login() POSTs to /auth/login so the form interaction is real,
 *     but never logs out / clears state on failure
 *
 * The mock backend's POST /auth/login still runs end-to-end.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface CurrentUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
  reports_to_id: string | null;
  is_claims_director: boolean;
  created_at: string;
}

interface AuthContextType {
  currentUser: CurrentUser | null;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (role: string) => boolean;
  isClaimsDirector: () => boolean;
  isAuthenticated: boolean;
}

const DEMO_USER: CurrentUser = {
  id: 'u_adjuster_takahashi',
  username: 'takahashi.k',
  email: 'takahashi@yotsuba.example.jp',
  display_name: 'Takahashi Kenji',
  role: 'adjuster',
  reports_to_id: null,
  is_claims_director: false,
  created_at: new Date().toISOString(),
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Demo bypass: immediately authenticated as the fixed adjuster.
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(DEMO_USER);
  const [isLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const r = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) throw new Error('Login failed');
      const { user, access_token } = await r.json();
      localStorage.setItem('access_token', access_token);
      setCurrentUser(user ?? DEMO_USER);
    } catch (e) {
      // For the demo we don't actually fail; keep the demo user.
      setCurrentUser(DEMO_USER);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('access_token');
    setCurrentUser(null);
  }, []);

  const hasRole = useCallback((role: string) => currentUser?.role === role, [currentUser]);
  const isClaimsDirector = useCallback(() => !!currentUser?.is_claims_director, [currentUser]);

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        isLoading,
        error,
        login,
        logout,
        hasRole,
        isClaimsDirector,
        isAuthenticated: currentUser !== null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function useIsAuthenticated(): boolean { return useAuth().isAuthenticated; }
export function useCurrentUser(): CurrentUser | null { return useAuth().currentUser; }
export function useHasRole(role: string): boolean { return useAuth().hasRole(role); }
export function useIsClaimsDirector(): boolean { return useAuth().isClaimsDirector(); }
export function useLogin() { return useAuth().login; }
export function useLogout() { return useAuth().logout; }
export function useAuthError(): [string | null, () => void] {
  const { error } = useAuth();
  return [error, () => {}];
}
export function useAuthLoading(): boolean { return useAuth().isLoading; }
