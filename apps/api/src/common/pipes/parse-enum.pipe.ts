import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParseEnumPipe implements PipeTransform<string, string> {
  constructor(private readonly enumType: Record<string, string>) {}

  transform(value: string): string {
    const enumValues = Object.values(this.enumType);
    if (!enumValues.includes(value)) {
      throw new BadRequestException(
        `Invalid value "${value}". Allowed values: ${enumValues.join(', ')}`,
      );
    }
    return value;
  }
}
