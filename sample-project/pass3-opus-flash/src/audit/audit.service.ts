import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  list(opts: { from?: Date; to?: Date; actor?: string; take?: number }) {
    return this.prisma.auditLog.findMany({
      where: {
        ts: {
          gte: opts.from,
          lte: opts.to
        },
        actor_id: opts.actor
      },
      orderBy: {
        ts: "desc"
      },
      take: opts.take ?? 100
    });
  }
}