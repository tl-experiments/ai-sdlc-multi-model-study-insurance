import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

export interface AuditOptions {
  action: string;
  resource?: string;
  maskResponse?: boolean;
}

/**
 * Decorator to specify audit logging options for a route.
 * @param options The audit options or action name.
 */
export const Audit = (options: AuditOptions | string) => {
  const metadata = typeof options === 'string' ? { action: options } : options;
  return SetMetadata(AUDIT_KEY, metadata);
};