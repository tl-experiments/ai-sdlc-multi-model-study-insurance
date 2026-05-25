# Workforce Operations — Web UI

React + Vite + Tailwind CSS frontend for the Workforce Operations Service.

## Features
- **Authentication**: Secure login with JWT storage, role-based routing, and session persistence.
- **Employee Directory**: Role-aware employee list with PII masking and detailed views.
- **Time Tracking**: Clock-in/out functionality with project tagging and real-time status.
- **Leave Management**: Submit leave requests, view balances, and approve/reject requests (managers).
- **Reports & Analytics**: Utilization, leave balance, and headcount dashboards with caching.
- **Audit Logs**: Read-only audit trail viewer for compliance auditors.

## Local Development

To run the entire stack locally:

### 1. Start the Backend Service
From the project root directory:
```bash
# Install dependencies, generate Prisma client, run migrations, seed database, and start backend
npm install
npx prisma generate
npx prisma db push
npm run prisma:seed
npm run start:dev # Backend runs on http://localhost:3000
```

### 2. Start the Web UI
From the `web` directory:
```bash
cd web
npm install
npm run dev # Web UI runs on http://localhost:5174
```

## Seeded Accounts for Testing

| Username | Password | Role | Purpose |
|---|---|---|---|
| `admin` | `admin123` | Admin | Full access, PII decryption, employee management |
| `mgr1` | `mgr1pass` | Manager | Team management, leave approvals, reports |
| `emp1` | `emp1pass` | Employee | Clock-in/out, leave requests, personal profile |
| `auditor1` | `audpass` | Auditor | Read-only access to audit logs and reports |