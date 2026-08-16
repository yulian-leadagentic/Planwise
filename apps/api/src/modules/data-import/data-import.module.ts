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

/**
 * Bulk-import module. M1 ships the Employees (users) importer; the
 * contacts sub-mode lives under `/data-import/contacts/*` and follows
 * the 6-stage methodology in `docs/bm2/bp-import-methodology.md`.
 * Each stage adds one service under `./contacts/` and one endpoint on
 * `ContactsImportController` — the shared scaffolding (permission
 * modules, DataImport job history) comes from the parent controller.
 */
@Module({
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
  ],
})
export class DataImportModule {}
