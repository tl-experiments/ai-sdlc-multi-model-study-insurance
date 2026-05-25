import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { TimeEntriesService } from "./time-entries.service";
import { ClockInDto } from "./dto/clock-in.dto";
import { UpdateTimeEntryDto } from "./dto/update-time-entry.dto";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { CurrentUser, AuthUser } from "../common/current-user.decorator";
import { EmployeesService } from "../employees/employees.service";

/**
 * Handles operations related to employee time entries, such as clock-in, clock-out,
 * and listing/updating entries. Access is protected and role-aware.
 */
@ApiTags("time-entries")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("time-entries")
export class TimeEntriesController {
  constructor(
    private readonly timeEntriesService: TimeEntriesService,
    private readonly employeesService: EmployeesService,
  ) {}

  /**
   * Creates a new time entry for the current user (clock-in).
   * Checks for overlapping entries.
   */
  @Post("clock-in")
  clockIn(@CurrentUser() user: AuthUser, @Body() clockInDto: ClockInDto) {
    return this.timeEntriesService.clockIn(user.id, clockInDto.project_tag);
  }

  /**
   * Closes the last open time entry for the current user (clock-out).
   */
  @Post("clock-out")
  clockOut(@CurrentUser() user: AuthUser) {
    return this.timeEntriesService.clockOut(user.id);
  }

  /**
   * Lists time entries. The scope of the list is determined by the user's role.
   * - Employees can only see their own entries.
   * - Managers can see their own entries and those of their direct/indirect reports.
   * - Admins can see all entries.
   * Supports filtering by employee ID and a date range.
   */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query("employee_id") employeeId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    let scopedEmployeeId = employeeId;

    // Role-based access control for listing time entries
    if (user.role === "employee") {
      if (employeeId && employeeId !== user.id) {
        throw new ForbiddenException(
          "Employees can only view their own time entries.",
        );
      }
      scopedEmployeeId = user.id;
    } else if (user.role === "manager" && employeeId && employeeId !== user.id) {
      // A manager can only view time entries of employees in their reporting line.
      const reportingChain = await this.employeesService.managerChain(employeeId);
      if (!reportingChain.has(user.id)) {
        throw new ForbiddenException(
          "You can only view time entries for your direct or indirect reports.",
        );
      }
    }
    // Admins and auditors have no restrictions on employeeId

    return this.timeEntriesService.list({
      employee_id: scopedEmployeeId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /**
   * Updates a specific time entry.
   * Note: The reference implementation lacks specific authorization for this endpoint.
   * It should be secured based on business rules (e.g., allow only managers or admins).
   */
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() updateTimeEntryDto: UpdateTimeEntryDto,
  ) {
    return this.timeEntriesService.update(id, updateTimeEntryDto);
  }
}