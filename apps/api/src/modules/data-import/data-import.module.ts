import { Module } from '@nestjs/common';
import { DataImportController } from './data-import.controller';
import { ExcelParserService } from './excel-parser.service';
import { UsersImporterService } from './importers/users-importer.service';
import {
  ContactsImportController,
  ContactsMappingPresetController,
} from './contacts/contacts-import.controller';
import { ContactsTriageService } from './contacts/triage.service';
import { ContactsHeaderDetectionService } from './contacts/header-detection.service';
import { ContactsMappingPresetService } from './contacts/mapping-preset.service';
import { ContactsSplitMergeService } from './contacts/split-merge.service';
import { ContactsDedupService } from './contacts/dedup.service';
import { ContactsResolveService } from './contacts/resolve.service';
import { ContactsCommitService } from './contacts/commit.service';
import { BusinessPartnersModule } from '../business-partners/business-partners.module';
import { UsersModule } from '../users/users.module';

/**
 * Bulk-import module. M1 ships the Employees (users) importer; the
 * contacts sub-mode lives under `/data-import/contacts/*` and follows
 * the 6-stage methodology in `docs/bm2/bp-import-methodology.md`.
 * Each stage adds one service under `./contacts/` and one endpoint on
 * `ContactsImportController` — the shared scaffolding (permission
 * modules, DataImport job history) comes from the parent controller.
 *
 * BusinessPartnersModule is imported so the contacts wizard can reuse
 * BusinessPartnersService (personal-domain catalog check + domain-first
 * org resolution) — keeps the wizard's dedup rules in lockstep with the
 * BP admin path.
 *
 * UsersModule is imported so `UsersImporterService` can call
 * `UsersService.ensureBpForUser` + `syncEmployeeBpRole` after the
 * per-row `tx.user.create` — B5-2 (2026-10-20). This is the fix that
 * stops the importer producing login users without a linked
 * BusinessPartner, which hid the Qualifications section on the
 * People edit modal for ~43% of active employees.
 */
@Module({
  imports: [BusinessPartnersModule, UsersModule],
  controllers: [
    DataImportController,
    ContactsImportController,
    ContactsMappingPresetController,
  ],
  providers: [
    ExcelParserService,
    UsersImporterService,
    ContactsTriageService,
    ContactsHeaderDetectionService,
    ContactsMappingPresetService,
    ContactsSplitMergeService,
    ContactsDedupService,
    ContactsResolveService,
    ContactsCommitService,
  ],
})
export class DataImportModule {}
