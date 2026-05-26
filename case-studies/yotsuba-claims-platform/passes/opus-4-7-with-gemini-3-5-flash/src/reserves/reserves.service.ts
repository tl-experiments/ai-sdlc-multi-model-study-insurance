import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ProposeReserveDto } from './dto/propose-reserve.dto';
import { RejectReserveDto } from './dto/reject-reserve.dto';

export interface Reserve {
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
}

@Injectable()
export class ReservesService {
  private reserves: Map<string, Reserve> = new Map();

  async propose(dto: ProposeReserveDto): Promise<Reserve> {
    if (dto.amount <= 0) {
      throw new BadRequestException('Reserve amount must be greater than zero.');
    }

    const id = `res-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const reserve: Reserve = {
      id,
      claimId: dto.claimId,
      amount: dto.amount,
      currency: dto.currency,
      justification: dto.justification,
      proposedBy: dto.proposedBy,
      proposedAt: new Date(),
      status: 'PROPOSED',
    };

    this.reserves.set(id, reserve);
    return reserve;
  }

  async approve(id: string, approvedBy: string): Promise<Reserve> {
    const reserve = this.reserves.get(id);
    if (!reserve) {
      throw new NotFoundException(`Reserve with ID ${id} not found.`);
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

  async reject(id: string, dto: RejectReserveDto): Promise<Reserve> {
    const reserve = this.reserves.get(id);
    if (!reserve) {
      throw new NotFoundException(`Reserve with ID ${id} not found.`);
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

  async getById(id: string): Promise<Reserve> {
    const reserve = this.reserves.get(id);
    if (!reserve) {
      throw new NotFoundException(`Reserve with ID ${id} not found.`);
    }
    return reserve;
  }

  async getAll(): Promise<Reserve[]> {
    return Array.from(this.reserves.values());
  }
}