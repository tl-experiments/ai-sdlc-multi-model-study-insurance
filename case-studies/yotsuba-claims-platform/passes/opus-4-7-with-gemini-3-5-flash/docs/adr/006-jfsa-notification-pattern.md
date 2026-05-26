# ADR 006: JFSA Notification Pattern

## Status
Accepted

## Context
As we expand our insurance operations into the Japanese market, we must comply with the strict regulatory requirements enforced by the Japan Financial Services Agency (JFSA). Under JFSA regulations, insurance providers are legally mandated to report specific critical events within highly rigid timelines. These events include:
- **Major Claims**: Claims exceeding specific financial thresholds or involving complex cross-border disputes.
- **Operational Incidents**: System outages, data breaches, or significant operational failures affecting policyholders.
- **Fraud & Misconduct**: Suspected internal fraud, money laundering (AML) concerns, or severe policyholder misconduct.

The JFSA requires a multi-stage reporting process:
1. **Initial Notification**: An immediate alert (often within 24 to 72 hours of discovery) outlining the nature of the incident.
2. **Detailed Report**: A comprehensive follow-up report within 15 days detailing the root cause, impact analysis, and remediation plan.

Failing to report these incidents or missing the regulatory deadlines can result in severe financial penalties, business suspension orders, or loss of our operating license.

To ensure compliance, we need a robust, automated, and auditable pattern to detect reportable events, manage the multi-stage notification lifecycle, track regulatory deadlines, and maintain a complete audit trail of all communications with the JFSA.

We evaluated several approaches:
1. **Manual Compliance Tracking**: Relying on claims agents or compliance officers to manually identify and report incidents. This is highly error-prone, lacks systemic safeguards, and risks missing critical regulatory deadlines.
2. **Inline Service-Level Triggers**: Embedding JFSA reporting logic directly inside business services (e.g., `ClaimService`). This tightly couples core business logic with regional regulatory rules, making the codebase difficult to maintain and scale to other jurisdictions.
3. **Decoupled Event-Driven Notification Pattern**: Utilizing our event-driven architecture to asynchronously detect reportable events, route them to a dedicated compliance engine, and manage the notification lifecycle through a state-tracked workflow.

## Decision
We will implement a **Decoupled Event-Driven JFSA Notification Pattern** to manage all regulatory reporting requirements for the Japanese market.

### 1. Architecture Overview
The pattern consists of three main components:
- **Event Handlers**: Asynchronous listeners that subscribe to domain events (e.g., `ClaimApprovedEvent`, `SecurityIncidentTriggeredEvent`) and forward them to the compliance engine.
- **JFSA Compliance Engine**: A centralized service (`JfsaNotificationService`) that evaluates events against JFSA reporting criteria (e.g., claim value, incident severity).
- **Notification Lifecycle State Machine**: A dedicated state tracker to manage the preparation, approval, and submission of reports to the JFSA.

### 2. Notification Lifecycle States
Each JFSA notification record will progress through the following states:
- **`PENDING_EVALUATION`**: The event has been flagged but is undergoing manual or automated compliance review to determine if it is legally reportable.
- **`REPORT_REQUIRED`**: The compliance team has confirmed the event is reportable. The initial 24-hour SLA countdown begins.
- **`INITIAL_SUBMITTED`**: The initial notification has been successfully compiled and submitted to the JFSA. The 15-day SLA countdown for the final report begins.
- **`FINAL_SUBMITTED`**: The comprehensive final report has been submitted and acknowledged by the JFSA (Terminal State).
- **`EXEMPT`**: The event was evaluated and determined not to meet the reporting threshold (Terminal State).

### 3. Implementation Details
We will implement a type-safe `JfsaNotificationService` in NestJS:

```typescript
export enum JfsaNotificationState {
  PENDING_EVALUATION = 'PENDING_EVALUATION',
  REPORT_REQUIRED = 'REPORT_REQUIRED',
  INITIAL_SUBMITTED = 'INITIAL_SUBMITTED',
  FINAL_SUBMITTED = 'FINAL_SUBMITTED',
  EXEMPT = 'EXEMPT',
}

export interface JfsaNotificationRule {
  id: string;
  eventName: string;
  evaluator: (payload: any) => boolean;
  initialSlaHours: number;
  finalSlaDays: number;
}

export const JFSA_RULES: JfsaNotificationRule[] = [
  {
    id: 'RULE-001',
    eventName: 'claim.created',
    evaluator: (payload) => payload.amountInUsd >= 500000,
    initialSlaHours: 24,
    finalSlaDays: 15,
  },
  {
    id: 'RULE-002',
    eventName: 'security.incident',
    evaluator: (payload) => payload.severity === 'CRITICAL',
    initialSlaHours: 24,
    finalSlaDays: 15,
  }
];
```

### 4. SLA Monitoring and Escalation
To guarantee compliance with JFSA deadlines:
- **SLA Timers**: When a notification enters `REPORT_REQUIRED` or `INITIAL_SUBMITTED`, the system will schedule automated SLA checks using our distributed task scheduler.
- **Escalation Alerts**: If a report is not submitted within 50% of the remaining SLA window, the system will trigger high-priority alerts (via Slack, PagerDuty, and email) to the Compliance Officer and the VP of Operations.
- **Audit Trail**: Every state transition, draft modification, and submission receipt must be logged in the immutable audit trail (as defined in [ADR 002](002-audit-immutability.md)) to prove compliance during regulatory audits.

## Consequences

### Positive (Benefits)
- **Guaranteed Regulatory Compliance**: Automated detection and SLA tracking minimize the risk of missed deadlines and regulatory penalties.
- **Decoupled Architecture**: Core business services remain completely unaware of JFSA-specific rules. The compliance logic is isolated within the `JfsaNotificationService`.
- **Operational Visibility**: Compliance teams have a centralized dashboard to track the status, deadlines, and history of all JFSA notifications.
- **Audit Readiness**: The immutable audit trail provides clear, indisputable evidence of compliance and timely reporting to external auditors.

### Negative (Trade-offs & Mitigations)
- **Eventual Consistency Latency**: Because the pattern is event-driven and asynchronous, there may be a slight delay (seconds) between the occurrence of an event and its detection by the compliance engine.
  - *Mitigation*: The event-driven bus will be configured with high-priority queues for compliance-related events to ensure near-instantaneous processing.
- **Maintenance of Regulatory Rules**: JFSA guidelines may change over time, requiring updates to the evaluation rules.
  - *Mitigation*: We will externalize the `JFSA_RULES` configuration to a database-backed rule engine, allowing compliance officers to adjust thresholds and SLAs without requiring a full code redeployment.