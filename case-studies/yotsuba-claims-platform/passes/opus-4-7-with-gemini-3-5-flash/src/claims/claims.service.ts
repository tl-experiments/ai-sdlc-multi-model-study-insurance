import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ClaimStatus, ClaimEvent, getNextStatus, getAvailableEvents } from './claims-status.fsm';
import { ClaimsChannelService, ClaimChannelType } from './claims-channel.service';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';

export interface WitnessStatement {
  witnessName: string;
  statement: string;
  contactInfo?: string;
  createdAt: Date;
}

export interface Claim {
  id: string;
  policyId: string;
  claimantId: string;
  amount: number;
  status: ClaimStatus;
  description: string;
  witnessStatements: WitnessStatement[];
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ClaimsService {
  private readonly claims = new Map<string, Claim>();

  constructor(private readonly channelService: ClaimsChannelService) {}

  createClaim(
    policyId: string,
    claimantId: string,
    amount: number,
    description: string,
    channelType: ClaimChannelType = ClaimChannelType.WEB,
  ): Claim {
    if (!policyId) {
      throw new BadRequestException('Policy ID is required');
    }
    if (!claimantId) {
      throw new BadRequestException('Claimant ID is required');
    }
    if (amount <= 0) {
      throw new BadRequestException('Claim amount must be greater than zero');
    }

    const claimId = `claim_${Math.random().toString(36).substr(2, 9)}`;
    const claim: Claim = {
      id: claimId,
      policyId,
      claimantId,
      amount,
      status: ClaimStatus.DRAFT,
      description,
      witnessStatements: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.claims.set(claimId, claim);

    this.channelService.initializeSession(claimId, channelType, { policyId, claimantId });
    this.channelService.addParticipant(claimId, claimantId);
    this.channelService.sendMessage(
      claimId,
      'SYSTEM',
      'SYSTEM',
      `Claim created in DRAFT status. Channel initialized via ${channelType}.`
    );

    return claim;
  }

  getClaim(id: string): Claim {
    const claim = this.claims.get(id);
    if (!claim) {
      throw new NotFoundException(`Claim with ID "${id}" not found`);
    }
    return claim;
  }

  getAllClaims(): Claim[] {
    return Array.from(this.claims.values());
  }

  getClaimsByClaimant(claimantId: string): Claim[] {
    return this.getAllClaims().filter((claim) => claim.claimantId === claimantId);
  }

  getClaimsByStatus(status: ClaimStatus): Claim[] {
    return this.getAllClaims().filter((claim) => claim.status === status);
  }

  updateClaimAmount(id: string, amount: number): Claim {
    const claim = this.getClaim(id);
    if (claim.status !== ClaimStatus.DRAFT) {
      throw new BadRequestException(`Cannot update claim amount when status is ${claim.status}. Updates are only allowed in DRAFT status.`);
    }
    if (amount <= 0) {
      throw new BadRequestException('Claim amount must be greater than zero');
    }

    claim.amount = amount;
    claim.updatedAt = new Date();
    this.claims.set(id, claim);

    this.channelService.sendMessage(
      id,
      'SYSTEM',
      'SYSTEM',
      `Claim amount updated to ${amount}`
    );

    return claim;
  }

  transitionStatus(id: string, event: ClaimEvent, actorId: string): Claim {
    const claim = this.getClaim(id);
    const oldStatus = claim.status;

    let nextStatus: ClaimStatus;
    try {
      nextStatus = getNextStatus(oldStatus, event);
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }

    claim.status = nextStatus;
    claim.updatedAt = new Date();
    this.claims.set(id, claim);

    if (actorId && actorId !== 'SYSTEM') {
      try {
        this.channelService.addParticipant(id, actorId);
      } catch (e) {
        // Ignore if already participant
      }
    }

    this.channelService.sendMessage(
      id,
      actorId || 'SYSTEM',
      actorId ? 'ADJUSTER' : 'SYSTEM',
      `Claim status transitioned from ${oldStatus} to ${nextStatus} via event ${event}`
    );

    if (nextStatus === ClaimStatus.SETTLED || nextStatus === ClaimStatus.CANCELLED) {
      try {
        this.channelService.closeSession(id);
      } catch (e) {
        // Ignore if already closed
      }
    }

    return claim;
  }

  addWitnessStatement(id: string, dto: AddWitnessStatementDto): Claim {
    const claim = this.getClaim(id);

    if (claim.status === ClaimStatus.SETTLED || claim.status === ClaimStatus.CANCELLED) {
      throw new BadRequestException(`Cannot add witness statement to a ${claim.status} claim`);
    }

    const statement: WitnessStatement = {
      witnessName: dto.witnessName,
      statement: dto.statement,
      contactInfo: dto.contactInfo,
      createdAt: new Date(),
    };

    claim.witnessStatements.push(statement);
    claim.updatedAt = new Date();
    this.claims.set(id, claim);

    const witnessId = `witness_${dto.witnessName.replace(/\s+/g, '_').toLowerCase()}`;
    try {
      this.channelService.addParticipant(id, witnessId);
    } catch (e) {
      // Ignore if already participant
    }

    this.channelService.sendMessage(
      id,
      witnessId,
      'WITNESS',
      `Witness Statement by ${dto.witnessName}: "${dto.statement}"`
    );

    return claim;
  }

  getAvailableTransitions(id: string): ClaimEvent[] {
    const claim = this.getClaim(id);
    return getAvailableEvents(claim.status);
  }

  addChannelMessage(
    claimId: string,
    senderId: string,
    senderRole: 'CLAIMANT' | 'ADJUSTER' | 'WITNESS' | 'SYSTEM',
    content: string,
    attachments?: Array<{ type: string; url: string }>
  ) {
    this.getClaim(claimId);
    return this.channelService.sendMessage(claimId, senderId, senderRole, content, attachments);
  }

  getChannelMessages(claimId: string) {
    this.getClaim(claimId);
    return this.channelService.getMessages(claimId);
  }
}