import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AddWitnessStatementDto {
  @IsString()
  @IsNotEmpty()
  witnessName: string;

  @IsString()
  @IsNotEmpty()
  statement: string;

  @IsString()
  @IsOptional()
  contactInfo?: string;
}