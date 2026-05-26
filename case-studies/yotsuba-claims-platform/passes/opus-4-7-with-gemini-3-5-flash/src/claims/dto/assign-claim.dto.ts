import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AssignClaimDto {
  @IsString()
  @IsNotEmpty()
  adjusterId: string;

  @IsString()
  @IsOptional()
  notes?: string;
}