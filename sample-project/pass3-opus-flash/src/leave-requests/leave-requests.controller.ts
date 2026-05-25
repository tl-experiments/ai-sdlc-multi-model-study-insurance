import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { LeaveRequestsService } from "./leave-requests.service";
import { CreateLeaveDto, DecideLeaveDto } from "./dto/create-leave.dto";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";
import { CurrentUser, AuthUser } from "../common/current-user.decorator";

@ApiTags("leave-requests")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("leave-requests")
export class LeaveRequestsController { 
  constructor(private readonly svc: LeaveRequestsService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateLeaveDto) {
    return this.svc.create(u.id, dto);
  }

  @Post(":id/approve")
  @Roles("manager", "admin")
  approve(
    @CurrentUser() u: AuthUser,
    @Param("id") id: string,
    @Body() dto: DecideLeaveDto
  ) {
    return this.svc.approve(u.id, id, dto.comments);
  }

  @Post(":id/reject")
  @Roles("manager", "admin")
  reject(
    @CurrentUser() u: AuthUser,
    @Param("id") id: string,
    @Body() dto: DecideLeaveDto
  ) {
    return this.svc.reject(u.id, id, dto.comments);
  }

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query("employee_id") employee_id?: string,
    @Query("status") status?: string
  ) {
    if (u.role === "employee") {
      if (employee_id && employee_id !== u.id) {
        throw new ForbiddenException("employee can only view own");
      }
      return this.svc.list({ employee_id: u.id, status });
    }
    return this.svc.list({ employee_id, status });
  }
}