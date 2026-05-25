import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from "class-validator";

export class CreateEmployeeDto {
  @ApiProperty() @IsString() @MinLength(3) username!: string;
  @ApiProperty() @IsString() @MinLength(6) password!: string;
  @ApiProperty({ enum: ["admin", "manager", "employee", "auditor"] })
  @IsIn(["admin", "manager", "employee", "auditor"])
  role!: "admin" | "manager" | "employee" | "auditor";
  @ApiProperty() @IsString() full_name!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() address?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() reports_to_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() government_id?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() bank_account?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() salary_base?: string;
}