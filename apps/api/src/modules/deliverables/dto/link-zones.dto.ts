import { IsArray, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LinkZonesDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @IsInt({ each: true })
  zoneIds: number[];
}
