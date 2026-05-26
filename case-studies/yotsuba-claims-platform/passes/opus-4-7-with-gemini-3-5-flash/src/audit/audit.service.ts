import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    userId?: string;
    action: string;
    details?: any;
    ipAddress?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        userId: data.userId || null,
        action: data.action,
        details: data.details || null,
        ipAddress: data.ipAddress || null,
      },
    });
  }

  async findAll(query?: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }) {
    const { userId, action, limit, offset } = query || {};
    const where: any = {};

    if (userId) {
      where.userId = userId;
    }
    if (action) {
      where.action = action;
    }

    return this.prisma.auditLog.findMany({
      where,
      take: limit ? Number(limit) : undefined,
      skip: offset ? Number(offset) : undefined,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const log = await this.prisma.auditLog.findUnique({
      where: { id },
    });
    if (!log) {
      throw new NotFoundException(`Audit log with ID "${id}" not found`);
    }
    return log;
  }
}