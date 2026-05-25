import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma.service";
import * as bcrypt from "bcrypt";

async function tokenFor(app: INestApplication, u: string, p: string): Promise<string> {
  const res = await request(app.getHttpServer()).post("/auth/login").send({ username: u, password: p });
  return res.body.access_token as string;
}

describe("LeaveRequests (e2e) — submit + manager approve + overlap reject", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let empToken: string;
  let mgrToken: string;
  let empId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const mgr = await prisma.employee.upsert({
      where: { username: "leave-mgr" }, update: {},
      create: { username: "leave-mgr", password_hash: await bcrypt.hash("mgrpw", 10), role: "manager", full_name: "Leave Mgr", email: "lm@x.com" },
    });
    const emp = await prisma.employee.upsert({
      where: { username: "leave-emp" }, update: {},
      create: { username: "leave-emp", password_hash: await bcrypt.hash("emppw", 10), role: "employee", reports_to_id: mgr.id, full_name: "Leave Emp", email: "le@x.com" },
    });
    empId = emp.id;
    await prisma.leaveBalance.upsert({
      where: { employee_id_leave_type: { employee_id: emp.id, leave_type: "annual" } },
      update: { balance: 5 },
      create: { employee_id: emp.id, leave_type: "annual", balance: 5 },
    });
    empToken = await tokenFor(app, "leave-emp", "emppw");
    mgrToken = await tokenFor(app, "leave-mgr", "mgrpw");
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({ where: { employee_id: empId } });
    await prisma.leaveBalance.deleteMany({ where: { employee_id: empId } });
    await prisma.auditLog.deleteMany({});
    await prisma.employee.deleteMany({ where: { username: { in: ["leave-mgr", "leave-emp"] } } });
    await app.close();
  });

  it("submit → manager approve → balance debits", async () => {
    const subRes = await request(app.getHttpServer())
      .post("/leave-requests").set("Authorization", `Bearer ${empToken}`)
      .send({ leave_type: "annual", from_date: "2030-01-10", to_date: "2030-01-12" });
    expect(subRes.status).toBe(201);
    const id = subRes.body.id;

    const appRes = await request(app.getHttpServer())
      .post(`/leave-requests/${id}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`).send({});
    expect(appRes.status).toBe(201);
    expect(appRes.body.status).toBe("approved");

    const bal = await prisma.leaveBalance.findUnique({
      where: { employee_id_leave_type: { employee_id: empId, leave_type: "annual" } },
    });
    expect(bal?.balance).toBe(2);
  });

  it("overlap with approved leave is rejected", async () => {
    const res = await request(app.getHttpServer())
      .post("/leave-requests").set("Authorization", `Bearer ${empToken}`)
      .send({ leave_type: "annual", from_date: "2030-01-11", to_date: "2030-01-13" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/overlap/i);
  });

  it("non-manager cannot approve", async () => {
    const sub = await request(app.getHttpServer())
      .post("/leave-requests").set("Authorization", `Bearer ${empToken}`)
      .send({ leave_type: "sick", from_date: "2030-02-01", to_date: "2030-02-01" });
    const id = sub.body.id;
    const res = await request(app.getHttpServer())
      .post(`/leave-requests/${id}/approve`)
      .set("Authorization", `Bearer ${empToken}`).send({});
    expect(res.status).toBe(403);
  });
});
