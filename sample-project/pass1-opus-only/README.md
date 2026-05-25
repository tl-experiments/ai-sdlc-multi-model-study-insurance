# Workforce Operations Service — Pass 1 (Opus-only)

NestJS backend + React/Vite frontend for HRMS + time-tracking with PII protection, RBAC, and audit logging. **Pass 1 build:** every line authored by Claude Opus 4.7. Baseline for the multi-model orchestration comparison.

## Quick start

```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma db push
npm run prisma:seed
npm test            # green
npm run start:dev   # serves on :3000, Swagger at /docs
```

For the web UI: `cd web && npm install && npm run dev` → http://localhost:5174

## Seeded accounts

| username | password | role |
|---|---|---|
| `admin` | `admin123` | admin |
| `mgr1`  | `mgr1pass` | manager (reports to admin) |
| `emp1`  | `emp1pass` | employee (reports to mgr1) |
| `auditor1` | `audpass` | auditor |

## Tests

`npm test` runs `*.e2e.spec.ts` files (Jest + Supertest, in-process):
- `auth.e2e.spec.ts` — login happy path, bad credentials, missing token
- `employees.e2e.spec.ts` — admin-vs-manager PII masking, authz, audit_log capture
- `leave.e2e.spec.ts` — submit, approve, balance debit, overlap rejection

## Provenance

Produced by `/ai-sdlc-pass1` slash command of the multi-model-orchestrator plugin. Telemetry per LLM call in `telemetry.jsonl`. Rolled-up cost in `manifest.json`.
