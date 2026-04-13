import { IsString, IsOptional, IsInt, IsEnum, IsArray, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { MessageEntityType } from '@prisma/client';

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
}
