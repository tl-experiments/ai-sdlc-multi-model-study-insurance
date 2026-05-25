import { Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma.service";
import { encryptToString, maybeDecrypt } from "../common/encryption";
import type { EmployeeView } from "../common/mask.util";
import { CreateEmployeeDto } from "./dto/create-employee.dto";
import { UpdateEmployeeDto } from "./dto/update-employee.dto";

@Injectable()
export class EmployeesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateEmployeeDto): Promise<EmployeeView> {
    const hash = await bcrypt.hash(dto.password, 10);
    const row = await this.prisma.employee.create({
      data: {
        username: dto.username,
        password_hash: hash,
        role: dto.role,
        reports_to_id: dto.reports_to_id ?? null,
        full_name: dto.full_name,
        email: dto.email,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
        government_id_ct: dto.government_id ? encryptToString(dto.government_id) : null,
        bank_account_ct: dto.bank_account ? encryptToString(dto.bank_account) : null,
        salary_base_ct: dto.salary_base ? encryptToString(dto.salary_base) : null,
      },
    });
    return this.toView(row);
  }

  async findOne(id: string): Promise<EmployeeView> {
    const row = await this.prisma.employee.findUnique({ where: { id } });
    if (!row || row.deleted_at) throw new NotFoundException("employee not found");
    return this.toView(row);
  }

  async findAll(opts: { page?: number; size?: number }): Promise<{ items: EmployeeView[]; total: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const size = Math.min(100, opts.size ?? 25);
    const [rows, total] = await Promise.all([
      this.prisma.employee.findMany({
        where: { deleted_at: null },
        skip: (page - 1) * size,
        take: size,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.employee.count({ where: { deleted_at: null } }),
    ]);
    return { items: rows.map((r: any) => this.toView(r)), total };
  }

  async update(id: string, dto: UpdateEmployeeDto): Promise<EmployeeView> {
    const data: any = { ...dto };
    if (dto.government_id !== undefined) {
      data.government_id_ct = dto.government_id ? encryptToString(dto.government_id) : null;
      delete data.government_id;
    }
    if (dto.bank_account !== undefined) {
      data.bank_account_ct = dto.bank_account ? encryptToString(dto.bank_account) : null;
      delete data.bank_account;
    }
    if (dto.salary_base !== undefined) {
      data.salary_base_ct = dto.salary_base ? encryptToString(dto.salary_base) : null;
      delete data.salary_base;
    }
    try {
      const row = await this.prisma.employee.update({ where: { id }, data });
      return this.toView(row);
    } catch { throw new NotFoundException("employee not found"); }
  }

  async softDelete(id: string): Promise<{ ok: true }> {
    await this.prisma.employee.update({ where: { id }, data: { deleted_at: new Date() } });
    return { ok: true };
  }

  /** Walks reports_to upwards. Explicit annotation avoids TS7022 from Prisma's self-relation type. */
  async managerChain(subjectId: string): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | null = subjectId;
    let safety = 50;
    while (cursor && safety-- > 0) {
      const row: { reports_to_id: string | null } | null = await this.prisma.employee.findUnique({
        where: { id: cursor },
        select: { reports_to_id: true },
      });
      const next: string | null = row?.reports_to_id ?? null;
      if (next) out.add(next);
      cursor = next;
    }
    return out;
  }

  private toView(row: any): EmployeeView {
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      government_id: maybeDecrypt(row.government_id_ct),
      bank_account: maybeDecrypt(row.bank_account_ct),
      salary_base: maybeDecrypt(row.salary_base_ct),
      reports_to_id: row.reports_to_id,
      created_at: row.created_at,
    };
  }
}
