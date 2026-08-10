import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class EnableSsoConfigDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}
