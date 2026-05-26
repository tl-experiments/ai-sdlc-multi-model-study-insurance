/**
 * App.tsx
 *
 * Root application component for the Yotsuba Claims Adjuster Workbench.
 *
 * Design constraints (from design.md §3, brief.md §2):
 *  - React Router v6 SPA routing
 *  - AuthProvider wraps the entire tree
 *  - Protected routes redirect unauthenticated users to /login
 *  - Role-aware navigation: manager sees Reserve Approvals; auditor sees Audit Log
 *  - Layout wraps all authenticated pages
 *  - Pages: Login, ClaimQueue, ClaimDetail, ReserveApprovals, AuditLog
 *  - Tailwind-only styling; no inline styles
 *  - No `any`; strict TypeScript throughout
 */

import React, { Suspense, lazy } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';

// ─── Lazy-loaded pages ────────────────────────────────────────────────────────
// Lazy-load each page so the initial bundle stays small.

const Login = lazy(() =>
  import('./pages/Login').then((m) => ({ default: m.Login })),
);
const ClaimQueue = lazy(() =>
  import('./pages/ClaimQueue').then((m) => ({ default: m.ClaimQueue })),
);
const ClaimDetail = lazy(() =>
  import('./pages/ClaimDetail').then((m) => ({ default: m.ClaimDetail })),
);
const ReserveApprovals = lazy(() =>
  import('./pages/ReserveApprovals').then((m) => ({ default: m.ReserveApprovals })),
);
const AuditLog = lazy(() =>
  import('./pages/AuditLog').then((m) => ({ default: m.AuditLog })),
);

// ─── Loading fallback ─────────────────────────────────────────────────────────

function PageSpinner(): React.ReactElement {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <SpinnerIcon className="h-8 w-8 animate-spin text-indigo-600" aria-hidden />
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    </div>
  );
}

// ─── Route guards ─────────────────────────────────────────────────────────────

/**
 * Redirects unauthenticated users to /login, preserving the intended
 * destination in router state so Login.tsx can redirect back after sign-in.
 */
function RequireAuth(): React.ReactElement {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    // While checking stored token, show a full-page spinner so we don't
    // flash the login page unnecessarily.
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <SpinnerIcon className="h-10 w-10 animate-spin text-indigo-600" aria-hidden />
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}

/**
 * Redirects authenticated users away from /login to /claims.
 */
function RedirectIfAuthenticated(): React.ReactElement {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <SpinnerIcon className="h-10 w-10 animate-spin text-indigo-600" aria-hidden />
      </div>
    );
  }

  if (user !== null) {
    // Redirect to the page they originally tried to access, or /claims.
    const from =
      (location.state as { from?: Location } | null)?.from?.pathname ?? '/claims';
    return <Navigate to={from} replace />;
  }

  return <Outlet />;
}

/**
 * Role-protected route: renders children only if the current user has one of
 * the allowed roles, otherwise navigates to /claims (a safe fallback).
 */
interface RequireRoleProps {
  allow: string[];
}

function RequireRole({ allow }: RequireRoleProps): React.ReactElement {
  const { user } = useAuth();

  if (user === null || !allow.includes(user.role)) {
    return <Navigate to="/claims" replace />;
  }

  return <Outlet />;
}

// ─── Authenticated layout wrapper ─────────────────────────────────────────────

/**
 * Renders the shared `<Layout>` shell around all authenticated pages.
 * The `<Outlet>` receives the matched child route's element.
 */
function AuthenticatedLayout(): React.ReactElement {
  return (
    <Layout>
      <Suspense fallback={<PageSpinner />}>
        <Outlet />
      </Suspense>
    </Layout>
  );
}

// ─── Router ───────────────────────────────────────────────────────────────────

function AppRouter(): React.ReactElement {
  return (
    <Routes>
      {/* ── Public routes ────────────────────────────────────────────── */}
      <Route element={<RedirectIfAuthenticated />}>
        <Route
          path="/login"
          element={
            <Suspense fallback={<PageSpinner />}>
              <Login />
            </Suspense>
          }
        />
      </Route>

      {/* ── Protected routes (require JWT) ───────────────────────────── */}
      <Route element={<RequireAuth />}>
        <Route element={<AuthenticatedLayout />}>
          {/* Default redirect */}
          <Route index element={<Navigate to="/claims" replace />} />

          {/* Claim queue — all authenticated roles */}
          <Route path="/claims" element={<ClaimQueue />} />

          {/* Claim detail — all authenticated roles (content role-masked server-side) */}
          <Route path="/claims/:id" element={<ClaimDetail />} />

          {/* Reserve approvals — manager + claims_director */}
          <Route
            element={
              <RequireRole allow={['manager']} />
            }
          >
            <Route path="/reserves/approvals" element={<ReserveApprovals />} />
          </Route>

          {/* Audit log — auditor only */}
          <Route element={<RequireRole allow={['auditor']} />}>
            <Route path="/audit" element={<AuditLog />} />
          </Route>

          {/* Catch-all inside authenticated shell → /claims */}
          <Route path="*" element={<Navigate to="/claims" replace />} />
        </Route>
      </Route>

      {/* Catch-all outside authenticated shell → /login */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

/**
 * `<App>` — top-level component.
 *
 * Wraps the app in:
 *  1. `<BrowserRouter>` — HTML5 history routing
 *  2. `<AuthProvider>` — JWT auth context
 *  3. `<AppRouter>` — route definitions
 *
 * @example
 * ```tsx
 * // main.tsx
 * ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
 * ```
 */
export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </BrowserRouter>
  );
}

// ─── SVG icon ─────────────────────────────────────────────────────────────────

interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

function SpinnerIcon({ className = 'h-6 w-6', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}