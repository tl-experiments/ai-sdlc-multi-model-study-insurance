import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EmployeesService } from '../employees/employees.service';

/**
 * Service for handling leave request operations.
 */
@Injectable()
export class LeaveRequestsService {
  constructor(
    private prisma: PrismaService,
    private emp: EmployeesService,
  ) {}

  /**
   * Creates a new leave request for an employee.
   * @param employee_id The ID of the employee submitting the request.
   * @param dto Data for the new leave request.
   * @returns The created leave request.
   * @throws {BadRequestException} If dates are invalid or overlap with existing approved leave.
   */
  async create(
    employee_id: string,
    dto: {
      leave_type: string;
      from_date: string;
      to_date: string;
      comments?: string;
    },
  ) {
    const from = new Date(dto.from_date);
    const to = new Date(dto.to_date);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format.');
    }
    if (to < from) {
      throw new BadRequestException('"to_date" cannot be earlier than "from_date".');
    }

    const overlap = await this.prisma.leaveRequest.findFirst({
      where: {
        employee_id,
        status: 'approved',
        from_date: { lte: to },
        to_date: { gte: from },
      },
    });

    if (overlap) {
      throw new BadRequestException(
        'The requested period overlaps with an existing approved leave request.',
      );
    }

    return this.prisma.leaveRequest.create({
      data: {
        employee_id,
        leave_type: dto.leave_type,
        from_date: from,
        to_date: to,
        comments: dto.comments,
        status: 'pending',
      },
    });
  }

  /**
   * Approves a pending leave request. This is a transactional operation that also debits the employee's leave balance.
   * @param actor_id The ID of the manager approving the request.
   * @param id The ID of the leave request.
   * @param comments Optional comments for the approval.
   * @returns The updated, approved leave request.
   * @throws {NotFoundException} If the leave request is not found.
   * @throws {BadRequestException} If the request is not pending or if the leave balance is insufficient.
   * @throws {ForbiddenException} If the actor is not a manager of the employee.
   */
  async approve(actor_id: string, id: string, comments?: string) {
    const lr = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!lr) {
      throw new NotFoundException('Leave request not found.');
    }
    if (lr.status !== 'pending') {
      throw new BadRequestException(`This leave request is already ${lr.status}.`);
    }

    const chain = await this.emp.managerChain(lr.employee_id);
    if (!chain.has(actor_id)) {
      throw new ForbiddenException(
        'You do not have permission to approve this leave request.',
      );
    }

    const days = Math.ceil((+lr.to_date - +lr.from_date) / 86400000) + 1;

    return this.prisma.$transaction(async (tx: any) => {
      if (lr.leave_type !== 'unpaid') {
        const bal = await tx.leaveBalance.findUnique({
          where: {
            employee_id_leave_type: {
              employee_id: lr.employee_id,
              leave_type: lr.leave_type,
            },
          },
        });

        if (!bal || bal.balance < days) {
          throw new BadRequestException(
            `Insufficient leave balance for type: ${lr.leave_type}.`,
          );
        }

        await tx.leaveBalance.update({
          where: { id: bal.id },
          data: { balance: bal.balance - days },
        });
      }

      return tx.leaveRequest.update({
        where: { id },
        data: {
          status: 'approved',
          decided_by: actor_id,
          comments: comments ?? lr.comments,
        },
      });
    });
  }

  /**
   * Rejects a pending leave request.
   * @param actor_id The ID of the manager rejecting the request.
   * @param id The ID of the leave request.
   * @param comments Optional comments for the rejection.
   * @returns The updated, rejected leave request.
   * @throws {NotFoundException} If the leave request is not found.
   * @throws {BadRequestException} If the request is not pending.
   * @throws {ForbiddenException} If the actor is not a manager of the employee.
   */
  async reject(actor_id: string, id: string, comments?: string) {
    const lr = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!lr) {
      throw new NotFoundException('Leave request not found.');
    }
    if (lr.status !== 'pending') {
      throw new BadRequestException(`This leave request is already ${lr.status}.`);
    }

    const chain = await this.emp.managerChain(lr.employee_id);
    if (!chain.has(actor_id)) {
      throw new ForbiddenException(
        'You do not have permission to reject this leave request.',
      );
    }

    return this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        decided_by: actor_id,
        comments: comments ?? lr.comments,
      },
    });
  }

  /**
   * Retrieves a list of leave requests, with optional filtering.
   * @param opts Filtering options.
   * @returns A list of leave requests.
   */
  list(opts: { employee_id?: string; status?: string }) {
    return this.prisma.leaveRequest.findMany({
      where: {
        employee_id: opts.employee_id,
        status: opts.status,
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }
}