import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuditService } from "./audit.service";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { RolesGuard } from "../common/roles.guard";
import { Roles } from "../common/roles.decorator";

@ApiTags("audit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("audit")
export class AuditController {
  constructor(private audit: AuditService) {}

  @Get()
  @Roles("auditor")
  list(@Query("from") from?: string, @Query("to") to?: string, @Query("actor") actor?: string) {
    return this.audit.list({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      actor,
    });
  }
}