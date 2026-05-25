import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Validates user credentials and returns a JWT access token upon success.
   * @param username The user's username.
   * @param pass The user's plain-text password.
   * @returns A promise that resolves to an object containing the access token and user role.
   * @throws UnauthorizedException if credentials are invalid or the user is inactive.
   */
  async login(
    username: string,
    pass: string,
  ): Promise<{ access_token: string; role: string }> {
    const employee = await this.prisma.employee.findUnique({
      where: { username },
    });

    if (!employee || employee.deleted_at) {
      // Do not differentiate between 'not found' and 'inactive' to prevent user enumeration.
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordMatching = await bcrypt.compare(pass, employee.password_hash);

    if (!isPasswordMatching) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = {
      sub: employee.id,
      username: employee.username,
      role: employee.role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: '1h',
    });

    return {
      access_token: accessToken,
      role: employee.role,
    };
  }
}