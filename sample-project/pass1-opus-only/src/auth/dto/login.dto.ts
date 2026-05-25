import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin" })
  @IsString() @MinLength(3)
  username!: string;

  @ApiProperty({ example: "admin123" })
  @IsString() @MinLength(4)
  password!: string;
}
