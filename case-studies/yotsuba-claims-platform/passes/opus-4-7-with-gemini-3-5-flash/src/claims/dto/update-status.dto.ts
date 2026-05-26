import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum ClaimStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
}

export class UpdateStatusDto {
  @IsEnum(ClaimStatus)
  @IsNotEmpty()
  status: ClaimStatus;

  @IsString()
  @IsOptional()
  notes?: string;
}