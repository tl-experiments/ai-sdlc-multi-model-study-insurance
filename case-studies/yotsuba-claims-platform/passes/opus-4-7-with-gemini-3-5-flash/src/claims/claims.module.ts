import { Module } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { ClaimsChannelService } from './claims-channel.service';
import { ClaimsController } from './claims.controller';

@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimsChannelService],
  exports: [ClaimsService, ClaimsChannelService],
})
export class ClaimsModule {}