/**
 * SeverityPill.tsx
 * Displays a claim severity level as a styled pill with severity-specific colors and icons.
 * Used throughout the Adjuster Workbench to indicate claim complexity and priority.
 */

import React from 'react';

/**
 * Claim severity type matching the backend ClaimSeverity enum.
 */
type ClaimSeverity = 'simple' | 'complex' | 'catastrophic';

/**
 * Severity metadata: display name, color classes, icon, and description.
 */
const SEVERITY_CONFIG: Record<
  ClaimSeverity,
  { label: string; bgColor: string; textColor: string; icon: string; description: string }
> = {
  simple: {
    label: 'Simple',
    bgColor: 'bg-green-100',
    textColor: 'text-green-800',
    icon: '✓',
    description: 'Straightforward claim, low complexity',
  },
  complex: {
    label: 'Complex',
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-800',
    icon: '⚙️',
    description: 'Multi-faceted claim requiring detailed investigation',
  },
  catastrophic: {
    label: 'Catastrophic',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    icon: '⚠️',
    description: 'High-value or high-impact claim requiring immediate escalation',
  },
};

/**
 * Props for the SeverityPill component.
 */
interface SeverityPillProps {
  severity: ClaimSeverity;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  showDescription?: boolean;
  className?: string;
}

/**
 * SeverityPill component — displays a claim severity level with color-coded styling.
 * @param severity - The claim severity to display
 * @param size - Pill size: 'sm' (small), 'md' (medium, default), 'lg' (large)
 * @param showIcon - Whether to display the severity icon (default: true)
 * @param showDescription - Whether to show a tooltip with severity description (default: false)
 * @param className - Additional CSS classes to apply
 * @returns Rendered severity pill
 */
export const SeverityPill: React.FC<SeverityPillProps> = ({
  severity,
  size = 'md',
  showIcon = true,
  showDescription = false,
  className = '',
}) => {
  const config = SEVERITY_CONFIG[severity];

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
 * SeverityPillGroup component — displays multiple severity pills in a row.
 * @param severities - Array of severities to display
 * @param size - Pill size
 * @param showIcon - Whether to show icons
 * @param className - Additional CSS classes
 * @returns Rendered group of severity pills
 */
interface SeverityPillGroupProps {
  severities: ClaimSeverity[];
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  className?: string;
}

export const SeverityPillGroup: React.FC<SeverityPillGroupProps> = ({
  severities,
  size = 'md',
  showIcon = true,
  className = '',
}) => {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`.trim()}>
      {severities.map((severity) => (
        <SeverityPill key={severity} severity={severity} size={size} showIcon={showIcon} />
      ))}
    </div>
  );
};

/**
 * getSeverityLabel — utility function to get the display label for a severity level.
 * @param severity - The claim severity
 * @returns Display label
 */
export function getSeverityLabel(severity: ClaimSeverity): string {
  return SEVERITY_CONFIG[severity]?.label || severity;
}

/**
 * getSeverityDescription — utility function to get the description for a severity level.
 * @param severity - The claim severity
 * @returns Severity description
 */
export function getSeverityDescription(severity: ClaimSeverity): string {
  return SEVERITY_CONFIG[severity]?.description || '';
}

/**
 * getSeverityColor — utility function to get the color classes for a severity level.
 * @param severity - The claim severity
 * @returns Object with bgColor and textColor
 */
export function getSeverityColor(severity: ClaimSeverity): { bgColor: string; textColor: string } {
  const config = SEVERITY_CONFIG[severity];
  return {
    bgColor: config?.bgColor || 'bg-gray-100',
    textColor: config?.textColor || 'text-gray-800',
  };
}

/**
 * isSeverityCatastrophic — utility function to check if a severity is catastrophic.
 * @param severity - The claim severity
 * @returns True if the severity is catastrophic
 */
export function isSeverityCatastrophic(severity: ClaimSeverity): boolean {
  return severity === 'catastrophic';
}

/**
 * isSeverityComplex — utility function to check if a severity is complex or higher.
 * @param severity - The claim severity
 * @returns True if the severity is complex or catastrophic
 */
export function isSeverityComplex(severity: ClaimSeverity): boolean {
  return severity === 'complex' || severity === 'catastrophic';
}