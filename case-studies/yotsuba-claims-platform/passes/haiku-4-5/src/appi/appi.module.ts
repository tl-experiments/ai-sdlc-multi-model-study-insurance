import { Module } from '@nestjs/common';
import { AppiService } from './appi.service';
import { AppiController } from './appi.controller';
import { PrismaService } from '../prisma.service';

/**
 * AppiModule
 *
 * Handles APPI (Act on the Protection of Personal Information) compliance operations:
 *   - Data-subject export (Article 28 disclosure right)
 *   - Personal data anonymisation (Article 17 special-care PII redaction)
 *
 * Exports:
 *   - AppiService: core APPI operations (data-subject-export, anonymise)
 *   - AppiController: HTTP endpoints for APPI operations
 *
 * Dependencies:
 *   - PrismaService: database access
 */
@Module({
  providers: [AppiService, PrismaService],
  controllers: [AppiController],
  exports: [AppiService],
})
export class AppiModule {}