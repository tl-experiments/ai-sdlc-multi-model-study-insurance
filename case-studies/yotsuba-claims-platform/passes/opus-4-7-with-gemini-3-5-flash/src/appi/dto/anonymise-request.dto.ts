import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';

export class AnonymiseRequestDto {
  @IsString()
  @IsNotEmpty()
  claimId: string;

  @IsString()
  @IsNotEmpty()
  requestedBy: string;

  @IsString()
  @IsOptional()
  reason?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  fields?: string[];
}