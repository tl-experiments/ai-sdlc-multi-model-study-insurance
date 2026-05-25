import { Module } from "@nestjs/common";
import { EmployeesService } from "./employees.service";
import { EmployeesController } from "./employees.controller";
import { PrismaService } from "../prisma.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [EmployeesService, PrismaService],
  controllers: [EmployeesController],
  exports: [EmployeesService],
})
export class EmployeesModule {}