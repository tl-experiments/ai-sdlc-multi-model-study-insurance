import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { TimeEntriesService } from "./time-entries.service";
import { ClockInDto } from "./dto/clock-in.dto";
import { UpdateTimeEntryDto } from "./dto/update-time-entry.dto";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { CurrentUser, AuthUser } from "../common/current-user.decorator";
import { EmployeesService } from "../employees/employees.service";

@ApiTags("time-entries")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("time-entries")
export class TimeEntriesController {
  constructor(private svc: TimeEntriesService, private emp: EmployeesService) {}

  @Post("clock-in")
  clockIn(@CurrentUser() u: AuthUser, @Body() dto: ClockInDto) {
    return this.svc.clockIn(u.id, dto.project_tag);
  }

  @Post("clock-out")
  clockOut(@CurrentUser() u: AuthUser) {
    return this.svc.clockOut(u.id);
  }

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query("employee_id") employee_id?: string,
    @Query("from") from?: string,
    @Query("to") to?: string
  ) {
    let scopedEmpId = employee_id;
    if (u.role === "employee") {
      if (employee_id && employee_id !== u.id) {
        throw new ForbiddenException("employee can only view own");
      }
      scopedEmpId = u.id;
    } else if (u.role === "manager" && employee_id && employee_id !== u.id) {
      const chain = await this.emp.managerChain(employee_id);
      if (!chain.has(u.id)) {
        throw new ForbiddenException("not your report");
      }
    }
    return this.svc.list({
      employee_id: scopedEmpId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateTimeEntryDto) {
    return this.svc.update(id, dto);
  }
}