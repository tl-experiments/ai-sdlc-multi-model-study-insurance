/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { encryptToString } from "../src/common/encryption";

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.employee.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      password_hash: await bcrypt.hash("admin123", 10),
      role: "admin",
      full_name: "Alice Admin",
      email: "admin@example.com",
      phone: "+1-555-0100",
      address: "1 Admin St",
      government_id_ct: encryptToString("ADMIN-GOV-001"),
      bank_account_ct: encryptToString("ACC-ADMIN-9001"),
      salary_base_ct: encryptToString("250000"),
    },
  });
  const mgr = await prisma.employee.upsert({
    where: { username: "mgr1" },
    update: {},
    create: {
      username: "mgr1",
      password_hash: await bcrypt.hash("mgr1pass", 10),
      role: "manager",
      reports_to_id: admin.id,
      full_name: "Bob Manager",
      email: "bob@example.com",
      phone: "+1-555-0200",
      government_id_ct: encryptToString("MGR-GOV-001"),
      bank_account_ct: encryptToString("ACC-MGR-9002"),
      salary_base_ct: encryptToString("150000"),
    },
  });
  await prisma.employee.upsert({
    where: { username: "emp1" },
    update: {},
    create: {
      username: "emp1",
      password_hash: await bcrypt.hash("emp1pass", 10),
      role: "employee",
      reports_to_id: mgr.id,
      full_name: "Carol Coder",
      email: "carol@example.com",
      phone: "+1-555-0301",
      government_id_ct: encryptToString("EMP-GOV-001"),
      bank_account_ct: encryptToString("ACC-EMP-9003"),
      salary_base_ct: encryptToString("90000"),
    },
  });
  await prisma.employee.upsert({
    where: { username: "auditor1" },
    update: {},
    create: {
      username: "auditor1",
      password_hash: await bcrypt.hash("audpass", 10),
      role: "auditor",
      full_name: "Dan Auditor",
      email: "dan@example.com",
    },
  });
  const everyone = await prisma.employee.findMany({
    where: { role: { in: ["admin", "manager", "employee"] } },
  });
  for (const emp of everyone) {
    for (const type of ["annual", "sick", "unpaid", "comp_off"]) {
      await prisma.leaveBalance.upsert({
        where: { employee_id_leave_type: { employee_id: emp.id, leave_type: type } },
        update: {},
        create: { employee_id: emp.id, leave_type: type, balance: type === "annual" ? 20 : 10 },
      });
    }
  }
  console.log("Seed complete.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
