import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ReportsService } from "./reports.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";

@ApiTags("reports")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin", "manager", "auditor")
@Controller("reports")
export class ReportsController {
  constructor(private svc: ReportsService) {}

  @Get("utilization")
  utilization(@Query("from") from: string, @Query("to") to: string, @Query("team") team?: string) {
    return this.svc.utilization(new Date(from), new Date(to), team);
  }

  @Get("leave-balance")
  leaveBalance(@Query("team") team?: string) { return this.svc.leaveBalance(team); }

  @Get("headcount")
  headcount(@Query("as_of") as_of: string, @Query("team") team?: string) {
    return this.svc.headcount(new Date(as_of), team);
  }
}
