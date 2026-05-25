import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma.service";
import * as bcrypt from "bcrypt";

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.employee.upsert({
      where: { username: "test-admin" },
      update: {},
      create: {
        username: "test-admin",
        password_hash: await bcrypt.hash("testpass", 10),
        role: "admin",
        full_name: "T A",
        email: "ta@example.com",
      },
    });
  });

  afterAll(async () => {
    await prisma.employee.deleteMany({ where: { username: "test-admin" } });
    await app.close();
  });

  it("POST /auth/login → 201 with access_token (happy)", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "test-admin", password: "testpass" });
    expect(res.status).toBe(201);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.role).toBe("admin");
  });

  it("POST /auth/login → 401 on bad password", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "test-admin", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("GET /auth/me without token → 401", async () => {
    const res = await request(app.getHttpServer()).get("/auth/me");
    expect(res.status).toBe(401);
  });
});