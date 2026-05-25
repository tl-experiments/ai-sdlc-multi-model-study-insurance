import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { EmployeesService } from "./employees.service";
import { CreateEmployeeDto } from "./dto/create-employee.dto";
import { UpdateEmployeeDto } from "./dto/update-employee.dto";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";
import { CurrentUser, AuthUser } from "../common/current-user.decorator";
import { maskEmployee } from "../common/mask.util";
import { Audit } from "../common/audit.interceptor";

@ApiTags("employees")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("employees")
export class EmployeesController {
  constructor(private svc: EmployeesService) {}

  @Post()
  @Roles("admin")
  @Audit({ action: "pii_write", fields: ["government_id", "bank_account", "salary_base"] })
  create(@Body() dto: CreateEmployeeDto) { return this.svc.create(dto); }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query("page") page?: string, @Query("size") size?: string) {
    const { items, total } = await this.svc.findAll({
      page: page ? Number(page) : undefined,
      size: size ? Number(size) : undefined,
    });
    const masked = await Promise.all(
      items.map(async (item) => maskEmployee(item, u, await this.svc.managerChain(item.id)))
    );
    return { items: masked, total };
  }

  @Get(":id")
  @Audit({ action: "pii_read", fields: ["government_id", "bank_account", "salary_base"], targetIdParam: "id" })
  async findOne(@CurrentUser() u: AuthUser, @Param("id") id: string) {
    const view = await this.svc.findOne(id);
    const chain = await this.svc.managerChain(id);
    if (u.role !== "admin" && u.role !== "auditor" && u.id !== view.id && !chain.has(u.id)) {
      throw new ForbiddenException("not authorized to view this employee");
    }
    return maskEmployee(view, u, chain);
  }

  @Patch(":id")
  @Roles("admin")
  @Audit({ action: "pii_write", targetIdParam: "id" })
  update(@Param("id") id: string, @Body() dto: UpdateEmployeeDto) { return this.svc.update(id, dto); }

  @Delete(":id")
  @Roles("admin")
  @Audit({ action: "pii_write", targetIdParam: "id", fields: ["deleted_at"] })
  remove(@Param("id") id: string) { return this.svc.softDelete(id); }
}