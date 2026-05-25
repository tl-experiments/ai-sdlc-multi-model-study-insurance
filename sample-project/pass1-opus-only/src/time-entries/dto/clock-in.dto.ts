import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class ClockInDto {
  @ApiProperty({ example: "PROJ-A" })
  @IsString() @MinLength(1)
  project_tag!: string;
}
