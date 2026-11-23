import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { BillingsService } from './billings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ProjectAccessService } from '../../common/services/project-access.service';
import {
  assertFinanceProjectAccess,
  financeProjectScope,
} from '../../common/services/finance-scope';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateBillingDto } from './dto/create-billing.dto';
import {
  AMOUNT_KEYS,
  assertFinanceFieldWrites,
  canSeeFinance,
  omitKeys,
} from '../../common/finance/finance-access';

/**
 * Round 4 (2026-11-23) — a billing's project is its contract's project;
 * finance:read reaches every project, anyone else needs project access.
 *
 * Permissions round 2 (B-12 / B-13) — `Billing.amount` is stripped for
 * callers without finance:read (ambiguous name, so per endpoint); a
 * changed amount needs finance:write and a changed status (approval
 * state) needs finance:approve. A new billing starts as `draft`, so
 * creating one in any other status is a status change.
 */
const BILLING_STATUS_FIELDS = ['status'] as const;
const BILLING_CREATE_DEFAULTS = { status: 'draft' };

@ApiTags('Billings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('billings')
export class BillingsController {
  constructor(
    private readonly billingsService: BillingsService,
    private readonly access: ProjectAccessService,
  ) {}

  private scope(user: any, projectId: number | null) {
    return assertFinanceProjectAccess(this.access, user, projectId);
  }

  @Post()
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create a billing' })
  async create(@CurrentUser() user: any, @Body() dto: CreateBillingDto) {
    await this.scope(user, await this.billingsService.getContractProjectId(dto.contractId));
    await assertFinanceFieldWrites(user, dto, AMOUNT_KEYS, null);
    await assertFinanceFieldWrites(user, dto, BILLING_STATUS_FIELDS, BILLING_CREATE_DEFAULTS, 'approve');
    const billing = await this.billingsService.create(user.id, dto);
    return canSeeFinance(user) ? billing : omitKeys(billing, AMOUNT_KEYS);
  }

  @Get()
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'List billings with filters' })
  async findAll(
    @CurrentUser() user: any,
    @Query('contractId') contractId?: number,
    @Query('status') status?: string,
  ) {
    if (contractId) await this.scope(user, await this.billingsService.getContractProjectId(Number(contractId)));
    const projectIds = contractId ? null : await financeProjectScope(this.access, user);
    const billings = await this.billingsService.findAll({ contractId, status }, projectIds);
    return canSeeFinance(user) ? billings : omitKeys(billings, AMOUNT_KEYS);
  }

  @Get(':id')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'Get billing by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.scope(user, await this.billingsService.getBillingProjectId(id));
    const billing = await this.billingsService.findOne(id);
    return canSeeFinance(user) ? billing : omitKeys(billing, AMOUNT_KEYS);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update billing status' })
  async update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    await this.scope(user, await this.billingsService.getBillingProjectId(id));
    const stored = () => this.billingsService.findOne(id);
    await assertFinanceFieldWrites(user, body, AMOUNT_KEYS, stored);
    await assertFinanceFieldWrites(user, body, BILLING_STATUS_FIELDS, stored, 'approve');
    const billing = await this.billingsService.update(id, body);
    return canSeeFinance(user) ? billing : omitKeys(billing, AMOUNT_KEYS);
  }
}
