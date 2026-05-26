import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';

export interface JfsaReserve {
  id: string;
  claimId: string;
  amount: number;
  currency: string;
  justification: string;
  proposedBy: string;
  proposedAt: Date;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  rejectionReason?: string;
  jfsaComplianceVerified: boolean;
}

@Injectable()
export class ReservesJfsaService {
  private reserves: Map<string, JfsaReserve> = new Map();

  async propose(dto: ProposeReserveDto): Promise<JfsaReserve> {
    if (dto.amount <= 0) {
      throw new BadRequestException('Reserve amount must be greater than zero.');
    }

    const requiresSpecialJustification = dto.currency !== 'JPY' && dto.amount > 1000000;
    if (requiresSpecialJustification && (!dto.justification || dto.justification.trim().length < 10)) {
      throw new BadRequestException(
        'JFSA compliance requires a detailed justification (at least 10 characters) for large non-JPY reserves.'
      );
    }

    const id = `jfsa-res-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const reserve: JfsaReserve = {
      id,
      claimId: dto.claimId,
      amount: dto.amount,
      currency: dto.currency,
      justification: dto.justification,
      proposedBy: dto.proposedBy,
      proposedAt: new Date(),
      status: 'PROPOSED',
      jfsaComplianceVerified: this.verifyCompliance(dto.amount, dto.currency),
    };

    this.reserves.set(id, reserve);
    return reserve;
  }

  async approve(id: string, approvedBy: string): Promise<JfsaReserve> {
    const reserve = this.reserves.get(id);
    if (!reserve) {
      throw new NotFoundException(`JFSA Reserve with ID ${id} not found.`);
    }

    if (reserve.status !== 'PROPOSED') {
      throw new BadRequestException(`Cannot approve reserve in ${reserve.status} status.`);
    }

    reserve.status = 'APPROVED';
    reserve.approvedBy = approvedBy;
    reserve.approvedAt = new Date();

    this.reserves.set(id, reserve);
    return reserve;
  }

  async reject(id: string, dto: RejectReserveDto): Promise<JfsaReserve> {
    const reserve = this.reserves.get(id);
    if (!reserve) {
      throw new NotFoundException(`JFSA Reserve with ID ${id} not found.`);
    }

    if (reserve.status !== 'PROPOSED') {
      throw new BadRequestException(`Cannot reject reserve in ${reserve.status} status.`);
    }

    reserve.status = 'REJECTED';
    reserve.rejectedBy = dto.rejectedBy;
    reserve.rejectedAt = new Date();
    reserve.rejectionReason = dto.reason;

    this.reserves.set(id, reserve);
    return reserve;
  }

  async getById(id: string): Promise<JfsaReserve> {
    const reserve = this.reserves.get(id);
    if (!reserve) {
      throw new NotFoundException(`JFSA Reserve with ID ${id} not found.`);
    }
    return reserve;
  }

  async getAll(): Promise<JfsaReserve[]> {
    return Array.from(this.reserves.values());
  }

  private verifyCompliance(amount: number, currency: string): boolean {
    if (currency === 'JPY') {
      return true;
    }
    return amount < 5000000;
  }
}