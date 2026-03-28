/**
 * Scaffold a new NestJS module
 * Usage: pnpm generate:module <name>
 * Example: pnpm generate:module invoices
 */

import fs from 'fs';
import path from 'path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: pnpm generate:module <name>');
  process.exit(1);
}

const pascalCase = name.charAt(0).toUpperCase() + name.slice(1);
const modulesDir = path.resolve(__dirname, '../../apps/api/src/modules', name);

if (fs.existsSync(modulesDir)) {
  console.error(`Module "${name}" already exists at ${modulesDir}`);
  process.exit(1);
}

fs.mkdirSync(modulesDir, { recursive: true });
fs.mkdirSync(path.join(modulesDir, 'dto'));

// Module
fs.writeFileSync(
  path.join(modulesDir, `${name}.module.ts`),
  `import { Module } from '@nestjs/common';
import { ${pascalCase}Controller } from './${name}.controller';
import { ${pascalCase}Service } from './${name}.service';

@Module({
  controllers: [${pascalCase}Controller],
  providers: [${pascalCase}Service],
  exports: [${pascalCase}Service],
})
export class ${pascalCase}Module {}
`,
);

// Controller
fs.writeFileSync(
  path.join(modulesDir, `${name}.controller.ts`),
  `import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { ${pascalCase}Service } from './${name}.service';

@ApiTags('${name}')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('${name}')
export class ${pascalCase}Controller {
  constructor(private readonly ${name}Service: ${pascalCase}Service) {}

  @Get()
  findAll(@Query() query: any) {
    return this.${name}Service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.${name}Service.findOne(+id);
  }

  @Post()
  create(@Body() dto: any) {
    return this.${name}Service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: any) {
    return this.${name}Service.update(+id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.${name}Service.remove(+id);
  }
}
`,
);

// Service
fs.writeFileSync(
  path.join(modulesDir, `${name}.service.ts`),
  `import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class ${pascalCase}Service {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: any) {
    // TODO: implement filtering and pagination
    return this.prisma.$queryRaw\`SELECT 1\`;
  }

  async findOne(id: number) {
    // TODO: implement
    throw new NotFoundException(\`${pascalCase} #\${id} not found\`);
  }

  async create(dto: any) {
    // TODO: implement
    return dto;
  }

  async update(id: number, dto: any) {
    // TODO: implement
    return { id, ...dto };
  }

  async remove(id: number) {
    // TODO: implement
    return { id };
  }
}
`,
);

console.log(`Module "${name}" scaffolded at ${modulesDir}`);
console.log(`  - ${name}.module.ts`);
console.log(`  - ${name}.controller.ts`);
console.log(`  - ${name}.service.ts`);
console.log(`  - dto/ (empty)`);
console.log(`\nDon't forget to import ${pascalCase}Module in app.module.ts`);
