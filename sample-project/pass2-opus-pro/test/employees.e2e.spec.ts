import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma.service";
import * as bcrypt from "bcrypt";

async function tokenFor(app: INestApplication, username: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post("/auth/login").send({ username, password });
  return res.body.access_token as string;
}

describe("Employees (e2e) — PII masking & authz", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let mgrToken: string;
  let subjId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.employee.upsert({
      where: { username: "e2e-admin" }, update: {},
      create: { username: "e2e-admin", password_hash: await bcrypt.hash("admin123", 10), role: "admin", full_name: "Admin", email: "a@x.com" },
    });
    const mgr = await prisma.employee.upsert({
      where: { username: "e2e-mgr" }, update: {},
      create: { username: "e2e-mgr", password_hash: await bcrypt.hash("mgr123", 10), role: "manager", full_name: "Mgr", email: "m@x.com" },
    });
    adminToken = await tokenFor(app, "e2e-admin", "admin123");
    mgrToken = await tokenFor(app, "e2e-mgr", "mgr123");

    const createRes = await request(app.getHttpServer())
      .post("/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        username: "e2e-subj", password: "subj123", role: "employee",
        reports_to_id: mgr.id, full_name: "Sub Ject", email: "s@x.com",
        government_id: "GOV-XXX-1234", bank_account: "ACC-9999-8888", salary_base: "120000",
      });
    expect(createRes.status).toBe(201);
    subjId = createRes.body.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.employee.deleteMany({ where: { username: { in: ["e2e-admin", "e2e-mgr", "e2e-subj"] } } });
    await app.close();
  });

  it("admin sees PII unmasked", async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${subjId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.government_id).toBe("GOV-XXX-1234");
    expect(res.body.bank_account).toBe("ACC-9999-8888");
    expect(res.body.salary_base).toBe("120000");
  });

  it("manager of subject sees PII masked (phone/address allowed)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${subjId}`).set("Authorization", `Bearer ${mgrToken}`);
    expect(res.status).toBe(200);
    expect(res.body.government_id).not.toBe("GOV-XXX-1234");
    expect(res.body.government_id).toMatch(/\*+/);
    expect(res.body.bank_account).toMatch(/\*+/);
    expect(res.body.salary_base).toMatch(/\*+/);
  });

  it("POST /employees forbidden for non-admin", async () => {
    const res = await request(app.getHttpServer())
      .post("/employees").set("Authorization", `Bearer ${mgrToken}`)
      .send({ username: "should-not-create", password: "x", role: "employee", full_name: "Nope", email: "n@x.com" });
    expect(res.status).toBe(403);
  });

  it("audit_log records pii_read on GET /employees/:id", async () => {
    const rows = await prisma.auditLog.findMany({ where: { target_id: subjId, action: "pii_read" } });
    expect(rows.length).toBeGreaterThan(0);
  });
});