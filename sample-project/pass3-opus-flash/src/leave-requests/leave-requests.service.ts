import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { EmployeesService } from "../employees/employees.service";

@Injectable()
export class LeaveRequestsService {
  constructor(private prisma: PrismaService, private emp: EmployeesService) {}

  async create(employee_id: string, dto: { leave_type: string; from_date: string; to_date: string; comments?: string }) {
    const from = new Date(dto.from_date);
    const to = new Date(dto.to_date);
    if (to < from) throw new BadRequestException("to_date < from_date");
    const overlap = await this.prisma.leaveRequest.findFirst({
      where: { employee_id, status: "approved", from_date: { lte: to }, to_date: { gte: from } },
    });
    if (overlap) throw new BadRequestException("overlaps with existing approved leave");
    return this.prisma.leaveRequest.create({
      data: {
        employee_id, leave_type: dto.leave_type,
        from_date: from, to_date: to,
        comments: dto.comments, status: "pending",
      },
    });
  }

  async approve(actor_id: string, id: string, comments?: string) {
    const lr = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!lr) throw new NotFoundException("leave request not found");
    if (lr.status !== "pending") throw new BadRequestException(`already ${lr.status}`);
    const chain = await this.emp.managerChain(lr.employee_id);
    if (!chain.has(actor_id)) throw new ForbiddenException("not the subject's manager");
    const days = Math.ceil((+lr.to_date - +lr.from_date) / 86400000) + 1;
    return this.prisma.$transaction(async (tx: any) => {
      const bal = await tx.leaveBalance.findUnique({
        where: { employee_id_leave_type: { employee_id: lr.employee_id, leave_type: lr.leave_type } }
      });
      if (lr.leave_type !== "unpaid" && (!bal || bal.balance < days)) {
        throw new BadRequestException(`insufficient ${lr.leave_type} balance`);
      }
      if (lr.leave_type !== "unpaid" && bal) {
        await tx.leaveBalance.update({ where: { id: bal.id }, data: { balance: bal.balance - days } });
      }
      return tx.leaveRequest.update({
        where: { id },
        data: { status: "approved", decided_by: actor_id, comments: comments ?? lr.comments },
      });
    });
  }

  async reject(actor_id: string, id: string, comments?: string) {
    const lr = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!lr) throw new NotFoundException("leave request not found");
    if (lr.status !== "pending") throw new BadRequestException(`already ${lr.status}`);
    const chain = await this.emp.managerChain(lr.employee_id);
    if (!chain.has(actor_id)) throw new ForbiddenException("not the subject's manager");
    return this.prisma.leaveRequest.update({
      where: { id },
      data: { status: "rejected", decided_by: actor_id, comments: comments ?? lr.comments },
    });
  }

  list(opts: { employee_id?: string; status?: string }) {
    return this.prisma.leaveRequest.findMany({
      where: { employee_id: opts.employee_id, status: opts.status },
      orderBy: { created_at: "desc" },
      take: 200,
    });
  }
}