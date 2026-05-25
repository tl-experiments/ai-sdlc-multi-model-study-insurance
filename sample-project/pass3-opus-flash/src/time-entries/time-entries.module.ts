import { Module } from "@nestjs/common";
import { TimeEntriesService } from "./time-entries.service";
import { TimeEntriesController } from "./time-entries.controller";
import { PrismaService } from "../prisma.service";
import { AuthModule } from "../auth/auth.module";
import { EmployeesModule } from "../employees/employees.module";

@Module({
  imports: [AuthModule, EmployeesModule],
  providers: [TimeEntriesService, PrismaService],
  controllers: [TimeEntriesController],
  exports: [TimeEntriesService],
})
export class TimeEntriesModule {}