import { Controller, Get, Post, Body, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReservesService } from './reserves.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ReservesExportService } from './reserves-export.service';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';

@Controller('reserves')
export class ReservesController {
  constructor(
    private readonly reservesService: ReservesService,
    private readonly reservesJfsaService: ReservesJfsaService,
    private readonly reservesExportService: ReservesExportService,
  ) {}

  @Get('export/csv')
  async exportCsv(
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: 'PROPOSED' | 'APPROVED' | 'REJECTED',
  ): Promise<string> {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=reserves.csv');
    return this.reservesExportService.exportToCsv(status);
  }

  @Get('export/json')
  async exportJson(
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: 'PROPOSED' | 'APPROVED' | 'REJECTED',
  ): Promise<string> {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=reserves.json');
    return this.reservesExportService.exportToJson(status);
  }

  @Post('jfsa')
  async proposeJfsa(@Body() dto: ProposeReserveDto) {
    return this.reservesJfsaService.propose(dto);
  }

  @Get('jfsa')
  async getAllJfsa() {
    return this.reservesJfsaService.getAll();
  }

  @Get('jfsa/:id')
  async getJfsaById(@Param('id') id: string) {
    return this.reservesJfsaService.getById(id);
  }

  @Post('jfsa/:id/approve')
  async approveJfsa(
    @Param('id') id: string,
    @Body('approvedBy') approvedBy: string,
  ) {
    return this.reservesJfsaService.approve(id, approvedBy);
  }

  @Post('jfsa/:id/reject')
  async rejectJfsa(
    @Param('id') id: string,
    @Body() dto: RejectReserveDto,
  ) {
    return this.reservesJfsaService.reject(id, dto);
  }

  @Post()
  async propose(@Body() dto: ProposeReserveDto) {
    return this.reservesService.propose(dto);
  }

  @Get()
  async getAll() {
    return this.reservesService.getAll();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.reservesService.getById(id);
  }

  @Post(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body('approvedBy') approvedBy: string,
  ) {
    return this.reservesService.approve(id, approvedBy);
  }

  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectReserveDto,
  ) {
    return this.reservesService.reject(id, dto);
  }
}