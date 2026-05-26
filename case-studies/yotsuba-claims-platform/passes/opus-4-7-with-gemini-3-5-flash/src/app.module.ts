import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { PrismaModule } from './prisma.module';
import { AuditModule } from './audit/audit.module';
import { ClaimsModule } from './claims/claims.module';
import { CustomersModule } from './customers/customers.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    ClaimsModule,
    CustomersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, CorrelationIdMiddleware)
      .forRoutes('*');
  }
}