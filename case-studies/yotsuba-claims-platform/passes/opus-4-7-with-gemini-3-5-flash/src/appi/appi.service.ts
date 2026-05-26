import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { AnonymiseRequestDto } from './dto/anonymise-request.dto';
import { randomUUID } from 'crypto';

export interface AnonymisationRequest {
  id: string;
  claimId: string;
  requestedBy: string;
  reason?: string;
  fields: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  rejectionReason?: string;
}

@Injectable()
export class AppiService {
  private requests: AnonymisationRequest[] = [];

  async propose(dto: AnonymiseRequestDto): Promise<AnonymisationRequest> {
    const request: AnonymisationRequest = {
      id: randomUUID(),
      claimId: dto.claimId,
      requestedBy: dto.requestedBy,
      reason: dto.reason,
      fields: dto.fields || ['name', 'email', 'phone', 'address'],
      status: 'PENDING',
      createdAt: new Date(),
    };
    this.requests.push(request);
    return request;
  }

  async getAll(): Promise<AnonymisationRequest[]> {
    return [...this.requests];
  }

  async getById(id: string): Promise<AnonymisationRequest> {
    const request = this.requests.find((r) => r.id === id);
    if (!request) {
      throw new NotFoundException(`Anonymisation request with ID ${id} not found`);
    }
    return request;
  }

  async approve(id: string, approvedBy: string): Promise<AnonymisationRequest> {
    const request = await this.getById(id);
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already in ${request.status} status`);
    }
    request.status = 'APPROVED';
    request.approvedBy = approvedBy;
    request.approvedAt = new Date();
    return request;
  }

  async reject(id: string, rejectedBy: string, reason?: string): Promise<AnonymisationRequest> {
    const request = await this.getById(id);
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already in ${request.status} status`);
    }
    request.status = 'REJECTED';
    request.rejectedBy = rejectedBy;
    request.rejectedAt = new Date();
    request.rejectionReason = reason;
    return request;
  }
}