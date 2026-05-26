import { IsString, IsNotEmpty, MinLength } from 'class-validator';

/**
 * Data Transfer Object for user login.
 *
 * Validates the username and password provided by the user during authentication.
 * Both fields are required and must meet minimum length requirements.
 *
 * Usage:
 *   @Post('/auth/login')
 *   login(@Body() dto: LoginDto) { ... }
 */
export class LoginDto {
  /**
   * The username of the user attempting to log in.
   *
   * Must be a non-empty string with a minimum length of 1 character.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  username: string;

  /**
   * The password of the user attempting to log in.
   *
   * Must be a non-empty string with a minimum length of 1 character.
   * In production, enforce stronger password policies (e.g., MinLength(8)).
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  password: string;
}