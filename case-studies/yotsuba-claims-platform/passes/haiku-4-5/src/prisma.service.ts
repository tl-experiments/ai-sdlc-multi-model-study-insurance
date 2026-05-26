import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma service that manages the database connection lifecycle.
 *
 * Context:
 *   NestJS applications need a single, managed instance of PrismaClient to handle
 *   all database operations. This service wraps PrismaClient and ensures proper
 *   initialization and cleanup during the application lifecycle.
 *
 * Behavior:
 *   1. On module initialization, connect to the database via PrismaClient.
 *   2. Expose the PrismaClient instance for use by other services via dependency injection.
 *   3. On module destruction, disconnect from the database to prevent connection leaks.
 *   4. Log connection events for observability.
 *
 * Usage:
 *   1. Import PrismaService in any module that needs database access:
 *      @Module({
 *        providers: [PrismaService],
 *        exports: [PrismaService],
 *      })
 *      export class SomeModule {}
 *
 *   2. Inject PrismaService into any service that needs database access:
 *      @Injectable()
 *      export class SomeService {
 *        constructor(private prisma: PrismaService) {}
 *
 *        async findUser(id: string) {
 *          return this.prisma.user.findUnique({ where: { id } });
 *        }
 *      }
 *
 *   3. The PrismaClient instance is available as `this.prisma` (the service itself
 *      extends PrismaClient, so it can be used directly).
 *
 * Database URL:
 *   The DATABASE_URL environment variable must be set in .env or provided at runtime.
 *   Example: postgresql://user:password@localhost:5432/yotsuba_claims
 *
 * Lifecycle:
 *   - OnModuleInit: called when the module is initialized; connects to the database.
 *   - OnModuleDestroy: called when the application is shutting down; disconnects.
 *
 * Error handling:
 *   Connection errors are logged and re-thrown; the application will fail to start
 *   if the database is unreachable. This is intentional — the application cannot
 *   function without a database connection.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Database connection established');
    } catch (error) {
      this.logger.error(
        `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      this.logger.log('Database connection closed');
    } catch (error) {
      this.logger.error(
        `Failed to disconnect from database: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}