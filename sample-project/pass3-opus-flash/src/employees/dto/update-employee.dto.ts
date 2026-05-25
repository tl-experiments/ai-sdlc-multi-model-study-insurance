import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString } from "class-validator";

export class UpdateEmployeeDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() full_name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() address?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() government_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() bank_account?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() salary_base?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() reports_to_id?: string;
}