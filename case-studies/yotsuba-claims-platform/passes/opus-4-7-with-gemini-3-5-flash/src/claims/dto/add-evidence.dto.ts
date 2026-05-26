import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AddEvidenceDto {
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsOptional()
  description?: string;
}