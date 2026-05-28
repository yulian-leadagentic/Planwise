import { Module } from '@nestjs/common';
import { DataImportController } from './data-import.controller';
import { ExcelParserService } from './excel-parser.service';
import { UsersImporterService } from './importers/users-importer.service';

/**
 * Bulk-import module. M1 ships the Employees (users) importer; partners
 * and contacts come in M2 + M3 and only need their importer service to
 * be added to providers + wired in DataImportController.getImporter().
 */
@Module({
  controllers: [DataImportController],
  providers: [ExcelParserService, UsersImporterService],
})
export class DataImportModule {}
