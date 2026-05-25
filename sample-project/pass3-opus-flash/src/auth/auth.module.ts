import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { PrismaService } from "../prisma.service";

@Module({
  imports: [JwtModule.register({})],
  providers: [AuthService, PrismaService],
  controllers: [AuthController],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}