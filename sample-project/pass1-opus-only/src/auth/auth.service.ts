import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma.service";

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  async login(username: string, password: string): Promise<{ access_token: string; role: string }> {
    const emp = await this.prisma.employee.findUnique({ where: { username } });
    if (!emp || emp.deleted_at) throw new UnauthorizedException("invalid credentials");
    const ok = await bcrypt.compare(password, emp.password_hash);
    if (!ok) throw new UnauthorizedException("invalid credentials");
    const access_token = await this.jwt.signAsync(
      { sub: emp.id, role: emp.role, username: emp.username },
      { secret: process.env.JWT_SECRET, expiresIn: "1h" }
    );
    return { access_token, role: emp.role };
  }
}
