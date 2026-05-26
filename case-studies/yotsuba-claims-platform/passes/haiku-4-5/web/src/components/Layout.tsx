/**
 * Layout.tsx
 * Main layout wrapper for the Adjuster Workbench.
 * Provides header, sidebar navigation, and role-based UI elements.
 * Used by all pages to maintain consistent structure and branding.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * User role type matching the backend UserRole enum.
 */
type UserRole = 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';

/**
 * Navigation item structure.
 */
interface NavItem {
  label: string;
  path: string;
  icon: string;
  roles: UserRole[];
}

/**
 * Navigation items available in the workbench.
 * Each item specifies which roles can access it.
 */
const NAV_ITEMS: NavItem[] = [
  {
    label: 'Claims Queue',
    path: '/claims',
    icon: '📋',
    roles: ['agent', 'adjuster', 'manager', 'auditor', 'siu_referrer'],
  },
  {
    label: 'Reserve Approvals',
    path: '/reserves',
    icon: '💰',
    roles: ['manager', 'auditor'],
  },
  {
    label: 'Audit Log',
    path: '/audit',
    icon: '📊',
    roles: ['auditor'],
  },
];

/**
 * Role display metadata.
 */
const ROLE_CONFIG: Record<UserRole, { label: string; color: string }> = {
  agent: { label: 'Agent', color: 'bg-blue-100 text-blue-800' },
  adjuster: { label: 'Adjuster', color: 'bg-green-100 text-green-800' },
  manager: { label: 'Manager', color: 'bg-purple-100 text-purple-800' },
  auditor: { label: 'Auditor', color: 'bg-orange-100 text-orange-800' },
  siu_referrer: { label: 'SIU Referrer', color: 'bg-red-100 text-red-800' },
};

/**
 * Props for the Layout component.
 */
interface LayoutProps {
  children: React.ReactNode;
}

/**
 * Header component — displays branding, user info, and logout button.
 */
interface HeaderProps {
  user: { username: string; role: UserRole; display_name: string } | null;
  onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ user, onLogout }) => {
  const [showUserMenu, setShowUserMenu] = useState(false);

  return (
    <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
      <div className="flex items-center justify-between px-6 py-4">
        {/* Branding */}
        <div className="flex items-center gap-3">
          <div className="text-2xl">🏢</div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Yotsuba Claims</h1>
            <p className="text-xs text-gray-500">Adjuster Workbench</p>
          </div>
        </div>

        {/* User menu */}
        {user && (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-3 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <div className="text-right">
                <p className="text-sm font-medium text-gray-900">{user.display_name}</p>
                <p className="text-xs text-gray-500">{user.username}</p>
              </div>
              <div className="text-xl">👤</div>
            </button>

            {/* User menu dropdown */}
            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                <div className="px-4 py-3 border-b border-gray-200">
                  <p className="text-sm font-medium text-gray-900">{user.display_name}</p>
                  <div className={`inline-block mt-2 px-2 py-1 rounded text-xs font-medium ${ROLE_CONFIG[user.role].color}`}>
                    {ROLE_CONFIG[user.role].label}
                  </div>
                </div>
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    onLogout();
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  🚪 Logout
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
};

/**
 * Sidebar component — displays navigation items filtered by user role.
 */
interface SidebarProps {
  userRole: UserRole;
  currentPath: string;
  onNavigate: (path: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  userRole,
  currentPath,
  onNavigate,
  isOpen,
  onClose,
}) => {
  const visibleItems = NAV_ITEMS.filter((item) => item.roles.includes(userRole));

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 lg:hidden z-30"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-16 h-[calc(100vh-4rem)] w-64 bg-gray-50 border-r border-gray-200 overflow-y-auto transition-transform lg:translate-x-0 z-40 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <nav className="p-4 space-y-2">
          {visibleItems.map((item) => {
            const isActive = currentPath === item.path;
            return (
              <button
                key={item.path}
                onClick={() => {
                  onNavigate(item.path);
                  onClose();
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-100 text-blue-900'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span className="text-lg">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
    </>
  );
};

/**
 * Layout component — main layout wrapper for the Adjuster Workbench.
 * Provides header, sidebar, and content area with responsive design.
 * @param children - Page content to render
 * @returns Rendered layout
 */
export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const navigate = useNavigate();
  const { currentUser: user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const currentPath = window.location.pathname;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (!user) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <Header user={user} onLogout={handleLogout} />

      <div className="flex">
        {/* Sidebar */}
        <Sidebar
          userRole={user.role}
          currentPath={currentPath}
          onNavigate={(path) => navigate(path)}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main content */}
        <main className="flex-1 lg:ml-64">
          {/* Mobile header button */}
          <div className="lg:hidden px-4 py-3 border-b border-gray-200 bg-white">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="Toggle navigation"
            >
              <span className="text-xl">☰</span>
            </button>
          </div>

          {/* Page content */}
          <div className="p-6">{children}</div>
        </main>
      </div>
    </div>
  );
};

/**
 * PageHeader component — displays a page title and optional description.
 * Used at the top of each page for consistent heading styling.
 */
interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: string;
  action?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  icon,
  action,
}) => {
  return (
    <div className="mb-6 flex items-start justify-between">
      <div>
        <div className="flex items-center gap-3 mb-2">
          {icon && <span className="text-3xl">{icon}</span>}
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
        </div>
        {description && <p className="text-gray-600">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
};

/**
 * Card component — reusable card container with consistent styling.
 * Used throughout the workbench for grouping related content.
 */
interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  title,
  subtitle,
}) => {
  return (
    <div className={`bg-white rounded-lg border border-gray-200 shadow-sm ${className}`.trim()}>
      {(title || subtitle) && (
        <div className="px-6 py-4 border-b border-gray-200">
          {title && <h2 className="text-lg font-semibold text-gray-900">{title}</h2>}
          {subtitle && <p className="text-sm text-gray-600 mt-1">{subtitle}</p>}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
};

/**
 * Section component — groups related content with optional title.
 * Lighter than Card; used for internal page sections.
 */
interface SectionProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
}

export const Section: React.FC<SectionProps> = ({ children, className = '', title }) => {
  return (
    <div className={`space-y-4 ${className}`.trim()}>
      {title && <h3 className="text-lg font-semibold text-gray-900">{title}</h3>}
      {children}
    </div>
  );
};

/**
 * Badge component — displays a small labeled badge.
 * Used for status, severity, and other categorical indicators.
 */
interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  className = '',
}) => {
  const variantClasses = {
    default: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    danger: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800',
  };

  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${variantClasses[variant]} ${className}`.trim()}
    >
      {children}
    </span>
  );
};

/**
 * RoleBadge component — displays a user role as a styled badge.
 * Matches the role color scheme defined in ROLE_CONFIG.
 */
interface RoleBadgeProps {
  role: UserRole;
  className?: string;
}

export const RoleBadge: React.FC<RoleBadgeProps> = ({ role, className = '' }) => {
  const config = ROLE_CONFIG[role];
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color} ${className}`.trim()}>
      {config.label}
    </span>
  );
};