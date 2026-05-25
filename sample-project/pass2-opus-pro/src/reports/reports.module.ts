import { Module } from "@nestjs/common";
import { ReportsService } from "./reports.service";
import { ReportsController } from "./reports.controller";
import { PrismaService } from "../prisma.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [ReportsService, PrismaService],
  controllers: [ReportsController],
  exports: [ReportsService],
})
export class ReportsModule {}