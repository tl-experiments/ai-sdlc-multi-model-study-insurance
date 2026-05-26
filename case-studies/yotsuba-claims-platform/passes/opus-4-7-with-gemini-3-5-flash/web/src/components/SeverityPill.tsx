import React from 'react';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface SeverityPillProps {
  severity: Severity | string;
  className?: string;
  showIcon?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'solid' | 'outline' | 'subtle';
}

function normalizeSeverity(severity: string): Severity {
  const s = severity.toLowerCase().trim();
  if (s.includes('critical') || s.includes('fatal') || s.includes('error') || s.includes('crit')) return 'critical';
  if (s.includes('high') || s.includes('warn')) return 'high';
  if (s.includes('medium') || s.includes('mod') || s.includes('med')) return 'medium';
  if (s.includes('info') || s.includes('debug')) return 'info';
  return 'low';
}

export function SeverityPill({
  severity,
  className = '',
  showIcon = true,
  size = 'md',
  variant = 'subtle',
}: SeverityPillProps) {
  const normalized = normalizeSeverity(severity);

  const icons = {
    info: (
      <svg
        className="flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
    low: (
      <svg
        className="flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
    medium: (
      <svg
        className="flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
    high: (
      <svg
        className="flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
    ),
    critical: (
      <svg
        className="flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M20.618 5.984A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016zM12 9v2m0 4h.01"
        />
      </svg>
    ),
  };

  const labels = {
    info: 'Info',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    critical: 'Critical',
  };

  const styles = {
    info: {
      subtle: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-900/50',
      solid: 'bg-sky-600 text-white border-transparent dark:bg-sky-700',
      outline: 'bg-transparent text-sky-600 border-sky-300 dark:text-sky-400 dark:border-sky-800',
    },
    low: {
      subtle: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900/50',
      solid: 'bg-emerald-600 text-white border-transparent dark:bg-emerald-700',
      outline: 'bg-transparent text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-800',
    },
    medium: {
      subtle: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/50',
      solid: 'bg-amber-500 text-white border-transparent dark:bg-amber-600',
      outline: 'bg-transparent text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-800',
    },
    high: {
      subtle: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900/50',
      solid: 'bg-orange-600 text-white border-transparent dark:bg-orange-700',
      outline: 'bg-transparent text-orange-600 border-orange-300 dark:text-orange-400 dark:border-orange-800',
    },
    critical: {
      subtle: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900/50',
      solid: 'bg-rose-600 text-white border-transparent dark:bg-rose-700',
      outline: 'bg-transparent text-rose-600 border-rose-300 dark:text-rose-400 dark:border-rose-800',
    },
  };

  const sizeClasses = {
    xs: 'px-1.5 py-0.5 text-[10px] font-bold rounded-sm border',
    sm: 'px-2 py-0.5 text-xs font-medium rounded border',
    md: 'px-2.5 py-0.5 text-xs font-semibold rounded-full border',
    lg: 'px-3 py-1 text-sm font-semibold rounded-full border',
  };

  const iconSizes = {
    xs: 'w-3 h-3 mr-0.5',
    sm: 'w-3.5 h-3.5 mr-1',
    md: 'w-3.5 h-3.5 mr-1',
    lg: 'w-4 h-4 mr-1.5',
  };

  const currentStyle = styles[normalized] || styles.low;
  const styleClass = currentStyle[variant] || currentStyle.subtle;
  const sizeClass = sizeClasses[size] || sizeClasses.md;
  const iconSizeClass = iconSizes[size] || iconSizes.md;

  const icon = icons[normalized] ? React.cloneElement(icons[normalized], {
    className: `${iconSizeClass} ${icons[normalized].props.className || ''}`
  }) : null;

  return (
    <span
      className={`inline-flex items-center justify-center transition-colors duration-150 ${sizeClass} ${styleClass} ${className}`}
    >
      {showIcon && icon}
      <span>{labels[normalized]}</span>
    </span>
  );
}