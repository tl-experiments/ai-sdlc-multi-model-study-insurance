import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Represents a single entry in the in-memory cache.
 */
interface CacheEntry {
  value: unknown;
  expires_at: number;
}

/**
 * Service responsible for generating business reports.
 * Implements a simple time-based in-memory cache for performance.
 */
@Injectable()
export class ReportsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly TTL_MS = 60_000; // 60 seconds

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A generic caching wrapper for report generation methods.
   * @param key The cache key.
   * @param build A function that generates the value if not found in cache.
   * @returns The cached or newly generated value.
   */
  private async cached<T>(key: string, build: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires_at > Date.now()) {
      return hit.value as T;
    }
    const value = await build();
    this.cache.set(key, { value, expires_at: Date.now() + this.TTL_MS });
    return value;
  }

  /**
   * Invalidates cache entries.
   * @param prefix If provided, only keys starting with this prefix are deleted. Otherwise, the entire cache is cleared.
   */
  public bust(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Calculates employee utilization over a given period.
   * @param from The start date of the period.
   * @param to The end date of the period.
   * @param team Optional team identifier (currently unused).
   * @returns A promise that resolves to an array of utilization data per employee.
   */
  public utilization(from: Date, to: Date, team?: string) {
    // Note: The `team` parameter is included for future extension but is not currently used in the query.
    return this.cached(`util:${+from}:${+to}:${team ?? ''}`, async () => {
      const entries = await this.prisma.timeEntry.findMany({
        where: {
          clock_in_at: { gte: from, lte: to },
          clock_out_at: { not: null },
        },
        select: { employee_id: true, clock_in_at: true, clock_out_at: true },
      });

      const loggedMsByEmployee = new Map<string, number>();
      for (const entry of entries) {
        // `clock_out_at` is guaranteed non-null by the `where` clause.
        const durationMs = (entry.clock_out_at as Date).getTime() - entry.clock_in_at.getTime();
        const currentTotal = loggedMsByEmployee.get(entry.employee_id) ?? 0;
        loggedMsByEmployee.set(entry.employee_id, currentTotal + durationMs);
      }

      const daysInRange = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
      const availableMs = daysInRange * 8 * 60 * 60 * 1000; // Assuming 8-hour workdays

      return Array.from(loggedMsByEmployee.entries()).map(([employee_id, totalMs]) => ({
        employee_id,
        billable_hours: parseFloat((totalMs / (1000 * 60 * 60)).toFixed(2)),
        utilization_pct: parseFloat(((totalMs / availableMs) * 100).toFixed(1)),
      }));
    });
  }

  /**
   * Retrieves the current leave balances for all employees.
   * @param team Optional team identifier (currently unused).
   * @returns A promise that resolves to an array of leave balance data per employee.
   */
  public leaveBalance(team?: string) {
    // Note: The `team` parameter is included for future extension but is not currently used in the query.
    return this.cached(`bal:${team ?? ''}`, async () => {
      const balances = await this.prisma.leaveBalance.findMany();

      const balancesByEmployee = new Map<string, Record<string, number>>();
      for (const balance of balances) {
        const employeeBalances = balancesByEmployee.get(balance.employee_id) ?? {};
        employeeBalances[balance.leave_type] = balance.balance;
        balancesByEmployee.set(balance.employee_id, employeeBalances);
      }

      return Array.from(balancesByEmployee.entries()).map(
        ([employee_id, balances]) => ({
          employee_id,
          balances,
        }),
      );
    });
  }

  /**
   * Calculates the total headcount on a specific date.
   * @param as_of The date for which to calculate the headcount.
   * @param team Optional team identifier (currently unused).
   * @returns A promise that resolves to the headcount report.
   */
  public headcount(as_of: Date, team?: string) {
    // Note: The `team` parameter is included for future extension but is not currently used in the query.
    return this.cached(`hc:${+as_of}:${team ?? ''}`, async () => {
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