import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post()
  async create(
    @Body() 
    data: {
      userId?: string;
      action: string;
      details?: any;
      ipAddress?: string;
    },
  ) {
    return this.auditService.create(data);
  }

  @Get()
  async findAll(
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.auditService.findAll({
      userId,
      action,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.auditService.findOne(id);
  }
}