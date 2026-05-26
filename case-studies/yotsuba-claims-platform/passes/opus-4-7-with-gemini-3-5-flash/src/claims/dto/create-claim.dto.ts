import { IsNotEmpty, IsNumber, IsOptional, IsString, IsDateString, Min } from 'class-validator';

export class CreateClaimDto {
  @IsString()
  @IsNotEmpty()
  policyId: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsDateString()
  @IsNotEmpty()
  incidentDate: string;

  @IsString()
  @IsOptional()
  claimantId?: string;
}