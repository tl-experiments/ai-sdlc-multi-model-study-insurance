// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/auth/dto/login.dto.ts
//
// Data Transfer Object for the POST /auth/login endpoint.
// Validated via class-validator; used by auth.controller.ts and auth.service.ts.
// =============================================================================

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'The unique username for the account.',
    example: 'adjuster_tanaka',
  })
  @IsString()
  @IsNotEmpty({ message: 'username must not be empty.' })
  @MaxLength(128, { message: 'username must not exceed 128 characters.' })
  username!: string;

  @ApiProperty({
    description: 'The account password.',
    example: 'S3cur3P@ssw0rd!',
  })
  @IsString()
  @IsNotEmpty({ message: 'password must not be empty.' })
  @MinLength(8, { message: 'password must be at least 8 characters.' })
  @MaxLength(256, { message: 'password must not exceed 256 characters.' })
  password!: string;
}