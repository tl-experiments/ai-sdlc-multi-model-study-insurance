import { Module } from '@nestjs/common';
import { ReservesController } from './reserves.controller';
import { ReservesService } from './reserves.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ReservesExportService } from './reserves-export.service';

@Module({
  controllers: [ReservesController],
  providers: [
    ReservesService,
    ReservesJfsaService,
    ReservesExportService,
  ],
  exports: [
    ReservesService,
    ReservesJfsaService,
    ReservesExportService,
  ],
})
export class ReservesModule {}