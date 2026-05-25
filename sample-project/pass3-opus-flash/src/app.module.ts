import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { PrismaService } from "./prisma.service";
import { AuthModule } from "./auth/auth.module";
import { EmployeesModule } from "./employees/employees.module";
import { TimeEntriesModule } from "./time-entries/time-entries.module";
import { LeaveRequestsModule } from "./leave-requests/leave-requests.module";
import { ReportsModule } from "./reports/reports.module";
import { AuditModule } from "./audit/audit.module";
import { AuditInterceptor } from "./common/audit.interceptor";
import { RequestIdMiddleware } from "./common/request-id.middleware";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        customProps: (req: any) => ({ request_id: req.id }),
        autoLogging: { ignore: (req: any) => req.url === "/health" },
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    AuthModule,
    AuditModule,
    EmployeesModule,
    TimeEntriesModule,
    LeaveRequestsModule,
    ReportsModule,
  ],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}