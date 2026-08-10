import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload for PUT /admin/drive.
 *
 * `serviceAccountKey` is write-only. When omitted or blank, the existing
 * stored ciphertext is preserved — this is how the admin UI edits
 * everything (Shared Drive id, root folder, enabled flag) without
 * knowing (or exposing) the current SA key.
 *
 * Any non-empty string is passed straight through SecretCryptoService
 * after being validated as JSON.parse-able.
 */
export class UpsertDriveConfigDto {
  @ApiProperty({ description: 'Google Shared-Drive ID (e.g. "0AGxxx...").' })
  @IsString()
  @MaxLength(191)
  sharedDriveId!: string;

  @ApiPropertyOptional({
    description:
      'Optional folder id inside the Shared Drive to use as the root for project folders. If null, project folders live at the top of the Shared Drive.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  rootFolderId?: string | null;

  @ApiPropertyOptional({
    description:
      'Write-only. Provide the FULL service-account JSON key to rotate. Omit or send an empty string to keep the current key.',
  })
  @IsOptional()
  @IsString()
  serviceAccountKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
