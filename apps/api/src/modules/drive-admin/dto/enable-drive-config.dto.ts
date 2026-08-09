import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class EnableDriveConfigDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}
