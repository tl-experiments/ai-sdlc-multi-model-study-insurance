import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Bootstrap function for the Yotsuba Insurance Claims Processing Platform.
 *
 * Context:
 *   This is the entry point for the NestJS application. It initializes the Express
 *   application, registers global middleware and pipes, configures security headers,
 *   sets up Swagger/OpenAPI documentation, and starts the HTTP server.
 *
 * Behavior:
 *   1. Create a NestJS application instance from AppModule.
 *   2. Register global middleware (RequestIdMiddleware, CorrelationIdMiddleware).
 *   3. Register global pipes (ValidationPipe for DTO validation).
 *   4. Enable Helmet for security headers (HSTS, CSP, X-Frame-Options, etc.).
 *   5. Configure and mount Swagger/OpenAPI documentation at /docs.
 *   6. Start the HTTP server on the configured port (default: 3000).
 *   7. Log startup information for observability.
 *
 * Environment variables:
 *   - NODE_ENV: 'development' | 'production' (default: 'development')
 *   - PORT: HTTP server port (default: 3000)
 *   - DATABASE_URL: PostgreSQL connection string (required)
 *   - JWT_SECRET: Secret key for JWT signing (required)
 *   - ENCRYPTION_KEK: Base64-encoded key encryption key for AES-256-GCM (required)
 *
 * Security:
 *   - Helmet is enabled to set secure HTTP headers.
 *   - ValidationPipe enforces DTO validation and rejects invalid payloads.
 *   - JWT authentication is enforced on protected routes via JwtAuthGuard.
 *   - CORS is configured in AppModule.
 *   - Rate limiting is configured on /auth/login via @nestjs/throttler.
 *
 * Swagger/OpenAPI:
 *   - Documentation is available at http://localhost:3000/docs
 *   - Includes all endpoints, DTOs, and security schemes.
 *   - Useful for API exploration and client code generation.
 *
 * Logging:
 *   - Startup messages are logged to stdout via NestJS Logger.
 *   - All request/response logging is handled by Pino (configured in AppModule).
 *   - Audit events are logged to the database via AuditInterceptor.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Register global validation pipe for DTO validation.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Enable Helmet for security headers.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  // Configure Swagger/OpenAPI documentation.
  const config = new DocumentBuilder()
    .setTitle('Yotsuba Insurance Claims Processing Platform')
    .setDescription(
      'Backend API for first-notice-of-loss-to-settlement lifecycle management. ' +
        'Handles FNOL intake, adjuster workbench, and reserves management for P&C claims.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token obtained from POST /auth/login',
      },
      'bearer',
    )
    .addTag('auth', 'Authentication endpoints')
    .addTag('claims', 'Claim FNOL intake and workbench')
    .addTag('reserves', 'Reserve management and approval')
    .addTag('audit', 'Audit log queries (auditor-only)')
    .addTag('appi', 'APPI data subject rights (data-subject-export, anonymise)')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayOperationId: true,
    },
  });

  // Start the HTTP server.
  const port = parseInt(process.env.PORT || '3000', 10);
  const nodeEnv = process.env.NODE_ENV || 'development';

  await app.listen(port);

  logger.log(
    `Yotsuba Claims Platform started on http://localhost:${port} (${nodeEnv})`,
  );
  logger.log(`Swagger documentation available at http://localhost:${port}/docs`);
}

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    `Failed to bootstrap application: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});