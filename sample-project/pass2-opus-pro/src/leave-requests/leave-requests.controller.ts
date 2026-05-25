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
  constructor(private readonly leaveRequestsService: LeaveRequestsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() createLeaveRequestDto: CreateLeaveDto) {
    return this.leaveRequestsService.create(user.id, createLeaveRequestDto);
  }

  @Post(":id/approve")
  @Roles("manager", "admin")
  approve(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() decideLeaveRequestDto: DecideLeaveDto,
  ) {
    return this.leaveRequestsService.approve(user.id, id, decideLeaveRequestDto.comments);
  }

  @Post(":id/reject")
  @Roles("manager", "admin")
  reject(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() decideLeaveRequestDto: DecideLeaveDto,
  ) {
    return this.leaveRequestsService.reject(user.id, id, decideLeaveRequestDto.comments);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query("employee_id") employeeId?: string,
    @Query("status") status?: string,
  ) {
    if (user.role === "employee") {
      if (employeeId && employeeId !== user.id) {
        throw new ForbiddenException("Employees can only view their own leave requests.");
      }
      // Force filter by current user's ID if the role is employee
      return this.leaveRequestsService.list({ employee_id: user.id, status });
    }

    // Managers and admins can view requests for other employees
    return this.leaveRequestsService.list({ employee_id: employeeId, status });
  }
}