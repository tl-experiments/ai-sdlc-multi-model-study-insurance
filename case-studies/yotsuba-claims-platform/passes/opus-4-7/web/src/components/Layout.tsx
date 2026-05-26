/**
 * Layout — top-level chrome for the Adjuster Workbench.
 *
 * Why this component exists
 * -------------------------
 * Every authenticated page in the Workbench (`ClaimQueue`, `ClaimDetail`,
 * `ReserveApprovals`, `AuditLog`) shares the same scaffolding:
 *
 *   - A header strip with the Yotsuba product mark, the primary nav,
 *     and an identity area showing the signed-in user plus their role
 *     badge and a sign-out affordance.
 *   - A main content region that scrolls independently of the header so
 *     long claim queues and audit logs do not push the navigation off
 *     screen.
 *   - A slim footer carrying the build-stamp / regulatory framing so
 *     reviewers see at a glance that this is a JFSA-aware platform.
 *
 * Centralising this here means individual pages only worry about their
 * own content. Navigation entries are role-filtered against the
 * `UserRole` enum exported by the API layer so an `auditor` sees the
 * audit log link but never the reserve-approvals link, and an
 * `adjuster` sees the queue but never the audit log.
 *
 * The component is intentionally self-contained: it consumes `useAuth`
 * for the current user and sign-out action, and `react-router`'s
 * `NavLink` / `Outlet` for routing. No data fetching, no business
 * logic — just the chrome.
 *
 * Accessibility
 * -------------
 * The header is a `<header>` landmark, the nav is a `<nav>` with an
 * `aria-label`, the main region is `<main>` and the footer is a
 * `<footer>` landmark. The active nav link carries `aria-current="page"`
 * so screen readers announce the current section.
 */

import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/api';
import { RoleBadge } from './RoleBadge';

// ─────────────────────────── nav descriptor ────────────────────────────

/**
 * Internal description of a navigation entry. Each entry declares the
 * set of roles that may see it; the header filters the list against
 * the signed-in user's role before rendering. This keeps the role
 * matrix from `brief.md` visible in one place rather than scattered as
 * conditional JSX throughout the layout.
 */
interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly roles: readonly UserRole[];
  readonly end?: boolean;
}

const NAV_ENTRIES: readonly NavEntry[] = [
  {
    to: '/claims',
    label: 'Claim Queue',
    roles: ['agent', 'adjuster', 'manager', 'auditor', 'siu_referrer'],
    end: false,
  },
  {
    to: '/reserves/approvals',
    label: 'Reserve Approvals',
    roles: ['manager'],
    end: false,
  },
  {
    to: '/audit',
    label: 'Audit Log',
    roles: ['auditor'],
    end: false,
  },
];

function entriesForRole(role: UserRole | undefined): readonly NavEntry[] {
  if (!role) {
    return [];
  }
  return NAV_ENTRIES.filter((entry) => entry.roles.includes(role));
}

// ─────────────────────────── product mark ──────────────────────────────

/**
 * Compact product mark. Two-tone wordmark — "Yotsuba" + "Claims" — so
 * the platform identity is unambiguous in screenshots while the
 * sub-label clarifies that this is the claims spine, not the policy
 * admin system.
 */
function ProductMark(): JSX.Element {
  return (
    <div className="flex items-center gap-2" aria-label="Yotsuba Claims">
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white shadow-sm"
      >
        Y
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-slate-900">Yotsuba</span>
        <span className="text-xs uppercase tracking-wide text-slate-500">
          Claims Workbench
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────── nav link styling ──────────────────────────

const BASE_NAV_LINK_CLASSES =
  'rounded-md px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2';

const INACTIVE_NAV_LINK_CLASSES = 'text-slate-600 hover:bg-slate-100 hover:text-slate-900';

const ACTIVE_NAV_LINK_CLASSES = 'bg-indigo-50 text-indigo-700';

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return [
    BASE_NAV_LINK_CLASSES,
    isActive ? ACTIVE_NAV_LINK_CLASSES : INACTIVE_NAV_LINK_CLASSES,
  ].join(' ');
}

// ─────────────────────────── component props ──────────────────────────

export interface LayoutProps {
  /**
   * Optional override for the main region's content. When omitted (the
   * common case) the layout renders a `<Outlet />` so nested routes
   * supply the page body. Supplying `children` directly is useful for
   * tests and for one-off pages mounted outside the router.
   */
  children?: ReactNode;
}

// ───────────────────────────── component ──────────────────────────────

/**
 * Render the authenticated Workbench shell.
 *
 * @example
 *   <Route element={<Layout />}> ...nested routes... </Route>
 */
export function Layout({ children }: LayoutProps): JSX.Element {
  const { user, signOut } = useAuth();
  const visibleEntries = entriesForRole(user?.role);

  const handleSignOut = (): void => {
    void signOut();
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <ProductMark />

          <nav aria-label="Primary" className="hidden md:block">
            <ul className="flex items-center gap-1" role="list">
              {visibleEntries.map((entry) => (
                <li key={entry.to}>
                  <NavLink to={entry.to} end={entry.end} className={navLinkClassName}>
                    {entry.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <>
                <div className="hidden flex-col items-end leading-tight sm:flex">
                  <span className="text-sm font-medium text-slate-800">
                    {user.display_name}
                  </span>
                  <span className="text-xs text-slate-500">{user.username}</span>
                </div>
                <RoleBadge role={user.role} />
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                >
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </div>

        {visibleEntries.length > 0 ? (
          <nav aria-label="Primary (compact)" className="md:hidden">
            <ul
              className="flex items-center gap-1 overflow-x-auto border-t border-slate-200 px-4 py-2"
              role="list"
            >
              {visibleEntries.map((entry) => (
                <li key={entry.to}>
                  <NavLink to={entry.to} end={entry.end} className={navLinkClassName}>
                    {entry.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {children ?? <Outlet />}
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span>
            © Yotsuba Insurance Holdings — Claims Platform (Track A POC)
          </span>
          <span className="sm:text-right">
            APPI-aware · JFSA threshold notifications · IFRS17 reserve categories
          </span>
        </div>
      </footer>
    </div>
  );
}

export default Layout;