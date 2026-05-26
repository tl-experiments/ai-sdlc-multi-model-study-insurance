/**
 * ClaimStatusPill.tsx
 * Displays a claim status as a styled pill with status-specific colors and icons.
 * Used throughout the Adjuster Workbench to indicate claim workflow state.
 */

import React from 'react';

/**
 * Claim status type matching the backend ClaimStatus enum.
 */
type ClaimStatus =
  | 'intake'
  | 'under_investigation'
  | 'awaiting_reserve_approval'
  | 'settlement_offered'
  | 'closed_paid'
  | 'closed_denied'
  | 'reopened';

/**
 * Status metadata: display name, color classes, icon, and description.
 */
const STATUS_CONFIG: Record<
  ClaimStatus,
  { label: string; bgColor: string; textColor: string; icon: string; description: string }
> = {
  intake: {
    label: 'Intake',
    bgColor: 'bg-gray-100',
    textColor: 'text-gray-800',
    icon: '📥',
    description: 'Claim received, awaiting initial processing',
  },
  under_investigation: {
    label: 'Under Investigation',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-800',
    icon: '🔍',
    description: 'Adjuster is investigating the claim',
  },
  awaiting_reserve_approval: {
    label: 'Awaiting Reserve Approval',
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-800',
    icon: '⏳',
    description: 'Reserve proposal pending manager approval',
  },
  settlement_offered: {
    label: 'Settlement Offered',
    bgColor: 'bg-green-100',
    textColor: 'text-green-800',
    icon: '✅',
    description: 'Settlement offer made to claimant',
  },
  closed_paid: {
    label: 'Closed — Paid',
    bgColor: 'bg-emerald-100',
    textColor: 'text-emerald-800',
    icon: '💰',
    description: 'Claim settled and payment issued',
  },
  closed_denied: {
    label: 'Closed — Denied',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    icon: '❌',
    description: 'Claim denied',
  },
  reopened: {
    label: 'Reopened',
    bgColor: 'bg-orange-100',
    textColor: 'text-orange-800',
    icon: '🔄',
    description: 'Claim reopened for further investigation',
  },
};

/**
 * Props for the ClaimStatusPill component.
 */
interface ClaimStatusPillProps {
  status: ClaimStatus;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  showDescription?: boolean;
  className?: string;
}

/**
 * ClaimStatusPill component — displays a claim status with color-coded styling.
 * @param status - The claim status to display
 * @param size - Pill size: 'sm' (small), 'md' (medium, default), 'lg' (large)
 * @param showIcon - Whether to display the status icon (default: true)
 * @param showDescription - Whether to show a tooltip with status description (default: false)
 * @param className - Additional CSS classes to apply
 * @returns Rendered status pill
 */
export const ClaimStatusPill: React.FC<ClaimStatusPillProps> = ({
  status,
  size = 'md',
  showIcon = true,
  showDescription = false,
  className = '',
}) => {
  const config = STATUS_CONFIG[status];

  if (!config) {
    return null;
  }

  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-base',
  };

  const pillClasses = `
    inline-flex items-center gap-1.5 rounded-full font-medium
    ${config.bgColor} ${config.textColor}
    ${sizeClasses[size]}
    ${className}
  `.trim();

  const pill = (
    <span className={pillClasses}>
      {showIcon && <span className="text-lg leading-none">{config.icon}</span>}
      <span>{config.label}</span>
    </span>
  );

  if (showDescription) {
    return (
      <div className="relative inline-block group">
        {pill}
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
          {config.description}
        </div>
      </div>
    );
  }

  return pill;
};

/**
 * ClaimStatusPillGroup component — displays multiple status pills in a row.
 * @param statuses - Array of statuses to display
 * @param size - Pill size
 * @param showIcon - Whether to show icons
 * @param className - Additional CSS classes
 * @returns Rendered group of status pills
 */
interface ClaimStatusPillGroupProps {
  statuses: ClaimStatus[];
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  className?: string;
}

export const ClaimStatusPillGroup: React.FC<ClaimStatusPillGroupProps> = ({
  statuses,
  size = 'md',
  showIcon = true,
  className = '',
}) => {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`.trim()}>
      {statuses.map((status) => (
        <ClaimStatusPill key={status} status={status} size={size} showIcon={showIcon} />
      ))}
    </div>
  );
};

/**
 * getStatusLabel — utility function to get the display label for a status.
 * @param status - The claim status
 * @returns Display label
 */
export function getStatusLabel(status: ClaimStatus): string {
  return STATUS_CONFIG[status]?.label || status;
}

/**
 * getStatusDescription — utility function to get the description for a status.
 * @param status - The claim status
 * @returns Status description
 */
export function getStatusDescription(status: ClaimStatus): string {
  return STATUS_CONFIG[status]?.description || '';
}

/**
 * getStatusColor — utility function to get the color classes for a status.
 * @param status - The claim status
 * @returns Object with bgColor and textColor
 */
export function getStatusColor(status: ClaimStatus): { bgColor: string; textColor: string } {
  const config = STATUS_CONFIG[status];
  return {
    bgColor: config?.bgColor || 'bg-gray-100',
    textColor: config?.textColor || 'text-gray-800',
  };
}

/**
 * isStatusTerminal — utility function to check if a status is a terminal state.
 * @param status - The claim status
 * @returns True if the status is terminal (closed_paid, closed_denied)
 */
export function isStatusTerminal(status: ClaimStatus): boolean {
  return status === 'closed_paid' || status === 'closed_denied';
}

/**
 * isStatusActive — utility function to check if a status is an active state.
 * @param status - The claim status
 * @returns True if the status is active (not terminal)
 */
export function isStatusActive(status: ClaimStatus): boolean {
  return !isStatusTerminal(status);
}