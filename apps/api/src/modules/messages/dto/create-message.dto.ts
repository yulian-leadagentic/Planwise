import {
  IsString,
  IsOptional,
  IsInt,
  IsEnum,
  IsArray,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { MessageEntityType } from '@prisma/client';

/**
 * File attached to a Message. Same shape as TaskAttachment but the
 * messages table doesn't have its own attachments table — we stash the
 * URL list inside Message.metadata.attachments so existing readers
 * keep working. The frontend uploads to /files/upload first, gets the
 * url, then sends the descriptor here.
 */
export class MessageAttachmentDto {
  @ApiProperty()
  @IsString()
  fileName: string;

  @ApiProperty()
  @IsString()
  fileUrl: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  fileSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class CreateMessageDto {
  @ApiProperty({ enum: MessageEntityType })
  @IsEnum(MessageEntityType)
  entityType: MessageEntityType;

  @ApiProperty()
  @IsInt()
  @Type(() => Number)
  entityId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  parentId?: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  content: string;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  mentionedUserIds?: number[];

  @ApiPropertyOptional({ type: [MessageAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageAttachmentDto)
  attachments?: MessageAttachmentDto[];
}
