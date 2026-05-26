import { Module } from '@nestjs/common';
import { AppiService } from './appi.service';
import { AppiController } from './appi.controller';

@Module({
  controllers: [AppiController],
  providers: [AppiService],
  exports: [AppiService],
})
export class AppiModule {}