import { Module } from "@nestjs/common";
import { LeaveRequestsService } from "./leave-requests.service";
import { LeaveRequestsController } from "./leave-requests.controller";
import { PrismaService } from "../prisma.service";
import { AuthModule } from "../auth/auth.module";
import { EmployeesModule } from "../employees/employees.module";

@Module({
  imports: [AuthModule, EmployeesModule],
  providers: [LeaveRequestsService, PrismaService],
  controllers: [LeaveRequestsController],
  exports: [LeaveRequestsService],
})
export class LeaveRequestsModule {}
