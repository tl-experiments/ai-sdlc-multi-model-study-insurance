import React from 'react';

export type UserRole = 'admin' | 'architect' | 'viewer';

export interface RoleBadgeProps {
  role: UserRole;
  className?: string;
  showIcon?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function RoleBadge({
  role,
  className = '',
  showIcon = true,
  size = 'md',
}: RoleBadgeProps) {
  const config = {
    admin: {
      label: 'Admin',
      bgClass: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-900/50',
      icon: (
        <svg
          className="w-3.5 h-3.5 mr-1 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        </svg>
      ),
    },
    architect: {
      label: 'Architect',
      bgClass: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-400 dark:border-indigo-900/50',
      icon: (
        <svg
          className="w-3.5 h-3.5 mr-1 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
      ),
    },
    viewer: {
      label: 'Viewer',
      bgClass: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400 dark:border-slate-800',
      icon: (
        <svg
          className="w-3.5 h-3.5 mr-1 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
          />
        </svg>
      ),
    },
  };

  const currentConfig = config[role] || config.viewer;

  const sizeClasses = {
    sm: 'px-1.5 py-0.5 text-xs font-medium rounded',
    md: 'px-2.5 py-0.5 text-xs font-semibold rounded-full border',
    lg: 'px-3 py-1 text-sm font-semibold rounded-full border',
  };

  const sizeClass = sizeClasses[size] || sizeClasses.md;

  return (
    <span
      className={`inline-flex items-center justify-center transition-colors duration-150 ${sizeClass} ${currentConfig.bgClass} ${className}`}
    >
      {showIcon && currentConfig.icon}
      <span>{currentConfig.label}</span>
    </span>
  );
}