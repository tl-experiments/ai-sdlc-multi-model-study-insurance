import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

interface CacheEntry { value: unknown; expires_at: number }

@Injectable()
export class ReportsService {
  private cache = new Map<string, CacheEntry>();
  private TTL_MS = 60_000;

  constructor(private prisma: PrismaService) {}

  private async cached<T>(key: string, build: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires_at > Date.now()) return hit.value as T;
    const value = await build();
    this.cache.set(key, { value, expires_at: Date.now() + this.TTL_MS });
    return value;
  }

  bust(prefix?: string): void {
    if (!prefix) { this.cache.clear(); return; }
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  utilization(from: Date, to: Date, team?: string) {
    return this.cached(`util:${+from}:${+to}:${team ?? ""}`, async () => {
      const entries = await this.prisma.timeEntry.findMany({
        where: { clock_in_at: { gte: from, lte: to }, clock_out_at: { not: null } },
        select: { employee_id: true, clock_in_at: true, clock_out_at: true },
      });
      const byEmp = new Map<string, number>();
      for (const e of entries) {
        const ms = +(e.clock_out_at as Date) - +e.clock_in_at;
        byEmp.set(e.employee_id, (byEmp.get(e.employee_id) ?? 0) + ms);
      }
      const days = Math.max(1, Math.ceil((+to - +from) / 86400000));
      const availableMs = days * 8 * 3600 * 1000;
      return Array.from(byEmp.entries()).map(([employee_id, ms]) => ({
        employee_id,
        billable_hours: +(ms / 3600000).toFixed(2),
        utilization_pct: +((ms / availableMs) * 100).toFixed(1),
      }));
    });
  }

  leaveBalance(team?: string) {
    return this.cached(`bal:${team ?? ""}`, async () => {
      const rows = await this.prisma.leaveBalance.findMany();
      const grouped = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const g = grouped.get(r.employee_id) ?? {};
        g[r.leave_type] = r.balance;
        grouped.set(r.employee_id, g);
      }
      return Array.from(grouped.entries()).map(([employee_id, balances]) => ({ employee_id, balances }));
    });
  }

  headcount(as_of: Date, team?: string) {
    return this.cached(`hc:${+as_of}:${team ?? ""}`, async () => {
      const count = await this.prisma.employee.count({
        where: {
          created_at: { lte: as_of },
          OR: [{ deleted_at: null }, { deleted_at: { gt: as_of } }],
        },
      });
      return { as_of, headcount: count };
    });
  }
}
