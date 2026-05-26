import { SetMetadata } from '@nestjs/common';

/**
 * Decorator to specify audit metadata for a route or handler.
 *
 * When applied to a controller method, this decorator marks the route as auditable.
 * The AuditInterceptor will capture the request/response and emit an AuditEvent record
 * with the specified action name, along with request_id, correlation_id, actor_id, and
 * a hash of the normalized payload.
 *
 * Usage:
 *   @Audit({ action: 'claim.created' })
 *   @Post('claims')
 *   createClaim(@Body() dto: CreateClaimDto, @CurrentUser() user: User) { ... }
 *
 *   @Audit({ action: 'claim.note.added' })
 *   @Post('claims/:id/notes')
 *   addNote(@Param('id') claimId: string, @Body() dto: AddNoteDto, @CurrentUser() user: User) { ... }
 *
 * The AuditInterceptor will:
 *   1. Extract the action from this decorator's metadata.
 *   2. Capture the request_id and correlation_id from the request context.
 *   3. Compute a sha-256 hash of the normalized request payload.
 *   4. After the handler completes, emit an AuditEvent row with all metadata.
 *   5. Never emit audit events for routes not decorated with @Audit().
 *
 * Action naming convention:
 *   - resource.action (e.g., 'claim.created', 'reserve.approved', 'evidence.added')
 *   - Use past tense for completed actions.
 *   - Include the resource type and the specific action for clarity.
 *
 * Audit events are immutable (append-only) and form the audit trail for regulatory
 * compliance and forensic investigation. See ADR-002 for immutability guarantees.
 */
export const Audit = (metadata: { action: string }) =>
  SetMetadata('audit', metadata);