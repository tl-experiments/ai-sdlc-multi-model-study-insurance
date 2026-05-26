/**
 * Layout.tsx
 *
 * Application shell for the Yotsuba Claims Adjuster Workbench.
 *
 * Design constraints:
 *  - Full-screen layout with a fixed sidebar and a scrollable main content area.
 *  - Navigation links correspond to the four pages in design.md:
 *    ClaimQueue, ClaimDetail (accessed via queue), ReserveApprovals, AuditLog.
 *  - Role-aware navigation: AuditLog only visible to auditor; ReserveApprovals
 *    only visible to manager / claims_director.
 *  - Displays the current user's role via RoleBadge.
 *  - Mobile-responsive: sidebar collapses to a top bar with hamburger toggle.
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Exports `Layout` as named export and `NavItem` type for external use.
 */

import React, { useState, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RoleBadge } from './RoleBadge';
import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NavItem {
  /** Route path this nav item links to. */
  href: string;
  /** Human-readable label. */
  label: string;
  /** Icon renderer. */
  icon: React.ReactElement;
  /** Roles that can see this nav item. When undefined, all roles can see it. */
  allowedRoles?: UserRole[];
}

export interface LayoutProps {
  children: React.ReactNode;
}

// ─── Navigation config ────────────────────────────────────────────────────────

/**
 * Primary navigation items.
 * Order defines the render order in the sidebar.
 */
const NAV_ITEMS: NavItem[] = [
  {
    href: '/claims',
    label: 'Claim Queue',
    icon: <ClaimQueueIcon className="h-5 w-5" />,
    // All authenticated roles can see the claim queue (role-scoped in the API).
    allowedRoles: undefined,
  },
  {
    href: '/reserves/approvals',
    label: 'Reserve Approvals',
    icon: <ReserveIcon className="h-5 w-5" />,
    allowedRoles: ['manager'],
  },
  {
    href: '/audit',
    label: 'Audit Log',
    icon: <AuditIcon className="h-5 w-5" />,
    allowedRoles: ['auditor'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the given role is allowed to see the nav item.
 */
function isNavItemVisible(item: NavItem, role: UserRole): boolean {
  if (item.allowedRoles === undefined) return true;
  return item.allowedRoles.includes(role);
}

/**
 * Returns true if the current path matches the nav item's href.
 * Exact match for root paths; prefix match for nested paths.
 */
function isNavItemActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<Layout>` — application shell for the Adjuster Workbench.
 *
 * Provides a fixed sidebar navigation and scrollable main content area.
 * Automatically hides navigation items the current user's role cannot access.
 *
 * @example
 * ```tsx
 * <Layout>
 *   <ClaimQueue />
 * </Layout>
 * ```
 */
export function Layout({ children }: LayoutProps): React.ReactElement {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleCloseSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleToggleSidebar = useCallback(
    () => setSidebarOpen((prev) => !prev),
    [],
  );

  const visibleNavItems =
    user !== null
      ? NAV_ITEMS.filter((item) => isNavItemVisible(item, user.role))
      : [];

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100">
      {/* ── Mobile sidebar backdrop ──────────────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-gray-900/50 lg:hidden"
          aria-hidden="true"
          onClick={handleCloseSidebar}
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-gray-900 transition-transform duration-300 ease-in-out',
          'lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        aria-label="Sidebar navigation"
      >
        {/* Logo / brand */}
        <div className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-gray-700/50 px-6">
          <YotsubaLogo className="h-8 w-8 flex-shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">
              Yotsuba Claims
            </p>
            <p className="truncate text-xs text-gray-400">
              Adjuster Workbench
            </p>
          </div>
          {/* Mobile close button */}
          <button
            type="button"
            className="ml-auto rounded-md p-1 text-gray-400 hover:text-white focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 lg:hidden"
            onClick={handleCloseSidebar}
            aria-label="Close sidebar"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Primary navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary navigation">
          <ul className="space-y-1" role="list">
            {visibleNavItems.map((item) => {
              const active = isNavItemActive(item.href, location.pathname);
              return (
                <li key={item.href}>
                  <Link
                    to={item.href}
                    onClick={handleCloseSidebar}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-300 hover:bg-gray-700/60 hover:text-white',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'flex-shrink-0 transition-colors',
                        active
                          ? 'text-white'
                          : 'text-gray-400 group-hover:text-white',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        {user !== null && (
          <div className="flex-shrink-0 border-t border-gray-700/50 p-4">
            <div className="flex items-center gap-3">
              {/* Avatar placeholder */}
              <div
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white"
                aria-hidden="true"
              >
                {user.display_name.charAt(0).toUpperCase()}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">
                  {user.display_name}
                </p>
                <RoleBadge role={user.role} size="sm" className="mt-0.5" />
              </div>

              {/* Logout button */}
              <button
                type="button"
                onClick={logout}
                className="flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 transition-colors"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogoutIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* ── Main content area ────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex h-16 flex-shrink-0 items-center gap-4 border-b border-gray-200 bg-white px-4 shadow-sm lg:hidden">
          <button
            type="button"
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 transition-colors"
            onClick={handleToggleSidebar}
            aria-label="Open sidebar"
            aria-expanded={sidebarOpen}
          >
            <HamburgerIcon className="h-5 w-5" />
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-3">
            <YotsubaLogo className="h-7 w-7 flex-shrink-0" />
            <span className="truncate text-sm font-semibold text-gray-800">
              Yotsuba Claims
            </span>
          </div>

          {user !== null && (
            <RoleBadge role={user.role} size="sm" />
          )}
        </header>

        {/* Desktop header breadcrumb strip */}
        <div className="hidden h-16 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 shadow-sm lg:flex">
          <PageTitle pathname={location.pathname} navItems={visibleNavItems} />
          {user !== null && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">
                {user.display_name}
              </span>
              <RoleBadge role={user.role} size="sm" />
              <button
                type="button"
                onClick={logout}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              >
                <LogoutIcon className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>

        {/* Scrollable page content */}
        <main
          className="flex-1 overflow-y-auto"
          id="main-content"
          tabIndex={-1}
        >
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Page title ───────────────────────────────────────────────────────────────

interface PageTitleProps {
  pathname: string;
  navItems: NavItem[];
}

/**
 * Derives a page title from the current pathname by matching nav items.
 * Falls back to a capitalised path segment for unlisted routes (e.g. /claims/:id).
 */
function PageTitle({ pathname, navItems }: PageTitleProps): React.ReactElement {
  // Try exact nav item match first.
  const matched = navItems.find((item) =>
    isNavItemActive(item.href, pathname),
  );
  if (matched !== undefined) {
    return (
      <h1 className="text-lg font-semibold text-gray-900">{matched.label}</h1>
    );
  }

  // Derive from the first path segment.
  const firstSegment = pathname.split('/').filter(Boolean)[0] ?? '';
  const derived =
    firstSegment.charAt(0).toUpperCase() +
    firstSegment.slice(1).replace(/-/g, ' ');

  return (
    <h1 className="text-lg font-semibold text-gray-900">
      {derived || 'Dashboard'}
    </h1>
  );
}

// ─── SVG icons ────────────────────────────────────────────────────────────────

interface IconProps {
  className?: string;
}

function YotsubaLogo({ className = 'h-8 w-8' }: IconProps): React.ReactElement {
  // Stylised shield / clover — evocative of P&C insurance without trademark issues.
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="8" fill="#4F46E5" />
      <path
        d="M16 6C16 6 8 10 8 17a8 8 0 0016 0C24 10 16 6 16 6z"
        fill="white"
        opacity="0.9"
      />
      <path
        d="M16 11a1 1 0 011 1v5.586l2.207 2.207a1 1 0 01-1.414 1.414L16 19.414l-1.793 1.793a1 1 0 01-1.414-1.414L15 17.586V12a1 1 0 011-1z"
        fill="#4F46E5"
      />
    </svg>
  );
}

function ClaimQueueIcon({ className = 'h-5 w-5' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ReserveIcon({ className = 'h-5 w-5' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z" />
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function AuditIcon({ className = 'h-5 w-5' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm0-7a1 1 0 10-2 0v3a1 1 0 102 0V7z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function HamburgerIcon({ className = 'h-5 w-5' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function XIcon({ className = 'h-5 w-5' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LogoutIcon({ className = 'h-4 w-4' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M3 3a1 1 0 011 1v12a1 1 0 11-2 0V4a1 1 0 011-1zm7.707 3.293a1 1 0 010 1.414L9.414 9H17a1 1 0 110 2H9.414l1.293 1.293a1 1 0 01-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}