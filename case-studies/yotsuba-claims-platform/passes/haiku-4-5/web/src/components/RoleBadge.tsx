/**
 * RoleBadge.tsx
 * Displays a user role as a styled badge with role-specific colors and icons.
 * Used throughout the Adjuster Workbench to indicate user permissions and responsibilities.
 */

import React from 'react';

/**
 * Role type matching the backend UserRole enum.
 */
type UserRole = 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';

/**
 * Role metadata: display name, color classes, and description.
 */
const ROLE_CONFIG: Record<UserRole, { label: string; bgColor: string; textColor: string; icon: string; description: string }> = {
  agent: {
    label: 'Agent',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-800',
    icon: '📞',
    description: 'FNOL intake agent',
  },
  adjuster: {
    label: 'Adjuster',
    bgColor: 'bg-green-100',
    textColor: 'text-green-800',
    icon: '🔍',
    description: 'Claims investigator',
  },
  manager: {
    label: 'Manager',
    bgColor: 'bg-purple-100',
    textColor: 'text-purple-800',
    icon: '👔',
    description: 'Claims manager',
  },
  auditor: {
    label: 'Auditor',
    bgColor: 'bg-orange-100',
    textColor: 'text-orange-800',
    icon: '📋',
    description: 'Audit and compliance',
  },
  siu_referrer: {
    label: 'SIU Referrer',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    icon: '⚠️',
    description: 'Fraud investigation referrer',
  },
};

/**
 * Props for the RoleBadge component.
 */
interface RoleBadgeProps {
  role: UserRole;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  showDescription?: boolean;
  className?: string;
}

/**
 * RoleBadge component — displays a role with color-coded styling.
 * @param role - The user role to display
 * @param size - Badge size: 'sm' (small), 'md' (medium, default), 'lg' (large)
 * @param showIcon - Whether to display the role icon (default: true)
 * @param showDescription - Whether to show a tooltip with role description (default: false)
 * @param className - Additional CSS classes to apply
 * @returns Rendered role badge
 */
export const RoleBadge: React.FC<RoleBadgeProps> = ({
  role,
  size = 'md',
  showIcon = true,
  showDescription = false,
  className = '',
}) => {
  const config = ROLE_CONFIG[role];

  if (!config) {
    return null;
  }

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-base',
  };

  const badgeClasses = `
    inline-flex items-center gap-1.5 rounded-full font-medium
    ${config.bgColor} ${config.textColor}
    ${sizeClasses[size]}
    ${className}
  `.trim();

  const badge = (
    <span className={badgeClasses}>
      {showIcon && <span className="text-lg leading-none">{config.icon}</span>}
      <span>{config.label}</span>
    </span>
  );

  if (showDescription) {
    return (
      <div className="relative inline-block group">
        {badge}
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
          {config.description}
        </div>
      </div>
    );
  }

  return badge;
};

/**
 * RoleBadgeGroup component — displays multiple role badges in a row.
 * @param roles - Array of roles to display
 * @param size - Badge size
 * @param showIcon - Whether to show icons
 * @param className - Additional CSS classes
 * @returns Rendered group of role badges
 */
interface RoleBadgeGroupProps {
  roles: UserRole[];
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  className?: string;
}

export const RoleBadgeGroup: React.FC<RoleBadgeGroupProps> = ({
  roles,
  size = 'md',
  showIcon = true,
  className = '',
}) => {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`.trim()}>
      {roles.map((role) => (
        <RoleBadge key={role} role={role} size={size} showIcon={showIcon} />
      ))}
    </div>
  );
};

/**
 * getRoleLabel — utility function to get the display label for a role.
 * @param role - The user role
 * @returns Display label
 */
export function getRoleLabel(role: UserRole): string {
  return ROLE_CONFIG[role]?.label || role;
}

/**
 * getRoleDescription — utility function to get the description for a role.
 * @param role - The user role
 * @returns Role description
 */
export function getRoleDescription(role: UserRole): string {
  return ROLE_CONFIG[role]?.description || '';
}

/**
 * getRoleColor — utility function to get the color classes for a role.
 * @param role - The user role
 * @returns Object with bgColor and textColor
 */
export function getRoleColor(role: UserRole): { bgColor: string; textColor: string } {
  const config = ROLE_CONFIG[role];
  return {
    bgColor: config?.bgColor || 'bg-gray-100',
    textColor: config?.textColor || 'text-gray-800',
  };
}