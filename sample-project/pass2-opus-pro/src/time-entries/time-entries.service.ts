import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

@Injectable()
export class TimeEntriesService {
  constructor(private prisma: PrismaService) {}

  async clockIn(employee_id: string, project_tag: string) {
    const open = await this.prisma.timeEntry.findFirst({
      where: { employee_id, clock_out_at: null },
    });
    if (open) {
      throw new BadRequestException("already clocked-in on another project");
    }
    return this.prisma.timeEntry.create({
      data: { employee_id, project_tag, clock_in_at: new Date() },
    });
  }

  async clockOut(employee_id: string) {
    const open = await this.prisma.timeEntry.findFirst({
      where: { employee_id, clock_out_at: null },
    });
    if (!open) {
      throw new BadRequestException("no open time entry to close");
    }
    return this.prisma.timeEntry.update({
      where: { id: open.id },
      data: { clock_out_at: new Date() },
    });
  }

  list(opts: { employee_id?: string; from?: Date; to?: Date }) {
    return this.prisma.timeEntry.findMany({
      where: {
        employee_id: opts.employee_id,
        clock_in_at: { gte: opts.from, lte: opts.to },
      },
      orderBy: { clock_in_at: "desc" },
      take: 200,
    });
  }

  async update(id: string, dto: { clock_in_at?: string; clock_out_at?: string }) {
    const row = await this.prisma.timeEntry.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException("time entry not found");
    }
    const ageMs = Date.now() - row.created_at.getTime();
    const needsApproval = ageMs > 24 * 60 * 60 * 1000;
    return this.prisma.timeEntry.update({
      where: { id },
      data: {
        clock_in_at: dto.clock_in_at ? new Date(dto.clock_in_at) : undefined,
        clock_out_at: dto.clock_out_at ? new Date(dto.clock_out_at) : undefined,
        approval_status: needsApproval ? "pending" : row.approval_status,
      },
    });
  }
}