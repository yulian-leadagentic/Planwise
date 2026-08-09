import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload for PUT /admin/sso/:provider.
 *
 * `secret` is write-only. When omitted or blank, the existing stored
 * ciphertext is preserved — this is how the admin UI edits everything
 * *except* the secret without knowing (or exposing) the current value.
 * Any non-empty string is passed straight through SecretCryptoService.
 */
export class UpsertSsoConfigDto {
  @ApiPropertyOptional({ description: 'Entra tenant id (GUID). Nullable — Google doesn\'t use one.' })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  tenantId?: string | null;

  @ApiProperty()
  @IsString()
  @MaxLength(191)
  clientId!: string;

  @ApiPropertyOptional({
    description: 'Write-only. Provide to rotate. Omit or send an empty string to keep the current secret.',
  })
  @IsOptional()
  @IsString()
  secret?: string;

  @ApiProperty({ description: 'Comma-separated list of allowed email domains (e.g. "acme.com, corp.acme.io").' })
  @IsString()
  @MaxLength(500)
  allowedDomains!: string;

  @ApiProperty()
  @IsInt()
  defaultRoleId!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ssoOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
