import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class UpdateTimeEntryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  clock_in_at?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  clock_out_at?: string;
}