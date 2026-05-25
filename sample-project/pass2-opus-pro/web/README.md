# Workforce Operations — Web UI (Pass 1)

React + Vite frontend. **Pass 1 build:** every line authored by Claude Opus 4.7.

## Local development
```bash
cd ..
npm install && npx prisma generate && npx prisma db push && npm run prisma:seed && npm run start:dev  # backend on :3000
cd web
npm install && npm run dev   # web on :5174
```

Seeded accounts: `admin/admin123`, `mgr1/mgr1pass`, `emp1/emp1pass`, `auditor1/audpass`.