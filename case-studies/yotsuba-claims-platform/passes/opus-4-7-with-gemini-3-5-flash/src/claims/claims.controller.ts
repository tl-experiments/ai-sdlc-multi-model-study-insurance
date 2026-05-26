import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ClaimsService, Claim } from './claims.service';
import { ClaimsChannelService, ClaimChannelType, ChannelConfig, ChannelMessage } from './claims-channel.service';
import { ClaimStatus, ClaimEvent } from './claims-status.fsm';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';

export class CreateClaimDto {
  policyId: string;
  claimantId: string;
  amount: number;
  description: string;
  channelType?: ClaimChannelType;
}

export class UpdateAmountDto {
  amount: number;
}

export class TransitionStatusDto {
  event: ClaimEvent;
  actorId: string;
}

export class SendMessageDto {
  senderId: string;
  senderRole: 'CLAIMANT' | 'ADJUSTER' | 'WITNESS' | 'SYSTEM';
  content: string;
  attachments?: Array<{ type: string; url: string }>;
}

export class UpdateChannelConfigDto {
  allowedFileTypes?: string[];
  maxFileSizeMb?: number;
  requiresMfa?: boolean;
  autoApproveThreshold?: number;
}

@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly channelService: ClaimsChannelService,
  ) {}

  @Post()
  createClaim(@Body() dto: CreateClaimDto): Claim {
    return this.claimsService.createClaim(
      dto.policyId,
      dto.claimantId,
      dto.amount,
      dto.description,
      dto.channelType,
    );
  }

  @Get()
  getClaims(
    @Query('claimantId') claimantId?: string,
    @Query('status') status?: ClaimStatus,
  ): Claim[] {
    if (claimantId) {
      return this.claimsService.getClaimsByClaimant(claimantId);
    }
    if (status) {
      return this.claimsService.getClaimsByStatus(status);
    }
    return this.claimsService.getAllClaims();
  }

  @Get(':id')
  getClaim(@Param('id') id: string): Claim {
    return this.claimsService.getClaim(id);
  }

  @Patch(':id/amount')
  updateClaimAmount(
    @Param('id') id: string,
    @Body() dto: UpdateAmountDto,
  ): Claim {
    return this.claimsService.updateClaimAmount(id, dto.amount);
  }

  @Post(':id/transitions')
  @HttpCode(HttpStatus.OK)
  transitionStatus(
    @Param('id') id: string,
    @Body() dto: TransitionStatusDto,
  ): Claim {
    return this.claimsService.transitionStatus(id, dto.event, dto.actorId);
  }

  @Get(':id/transitions')
  getAvailableTransitions(@Param('id') id: string): ClaimEvent[] {
    return this.claimsService.getAvailableTransitions(id);
  }

  @Post(':id/witness-statements')
  addWitnessStatement(
    @Param('id') id: string,
    @Body() dto: AddWitnessStatementDto,
  ): Claim {
    return this.claimsService.addWitnessStatement(id, dto);
  }

  @Post(':id/messages')
  sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ): ChannelMessage {
    return this.claimsService.addChannelMessage(
      id,
      dto.senderId,
      dto.senderRole,
      dto.content,
      dto.attachments,
    );
  }

  @Get(':id/messages')
  getMessages(@Param('id') id: string): ChannelMessage[] {
    return this.claimsService.getChannelMessages(id);
  }

  @Get('channels/:channelType/config')
  getChannelConfig(@Param('channelType') channelType: ClaimChannelType): ChannelConfig {
    return this.channelService.getChannelConfig(channelType);
  }

  @Patch('channels/:channelType/config')
  updateChannelConfig(
    @Param('channelType') channelType: ClaimChannelType,
    @Body() dto: UpdateChannelConfigDto,
  ): ChannelConfig {
    return this.channelService.updateChannelConfig(channelType, dto);
  }
}