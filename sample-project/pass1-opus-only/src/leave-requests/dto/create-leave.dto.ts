import { ApiProperty } from "@nestjs/swagger";
import { IsDateString, IsIn, IsOptional, IsString } from "class-validator";

export class CreateLeaveDto {
  @ApiProperty({ enum: ["annual", "sick", "unpaid", "comp_off"] })
  @IsIn(["annual", "sick", "unpaid", "comp_off"])
  leave_type!: "annual" | "sick" | "unpaid" | "comp_off";

  @ApiProperty() @IsDateString() from_date!: string;
  @ApiProperty() @IsDateString() to_date!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() comments?: string;
}

export class DecideLeaveDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() comments?: string;
}
