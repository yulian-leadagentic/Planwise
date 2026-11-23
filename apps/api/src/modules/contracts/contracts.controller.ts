import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { ContractsService } from './contracts.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ProjectAccessService } from '../../common/services/project-access.service';
import {
  assertFinanceProjectAccess,
  financeProjectScope,
} from '../../common/services/finance-scope';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { CreateContractDto } from './dto/create-contract.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';
import {
  AMOUNT_KEYS,
  assertFinanceFieldWrites,
  canSeeFinance,
  CONTRACT_ITEM_MONEY_KEYS,
  omitKeys,
} from '../../common/finance/finance-access';

/**
 * Round 4 (2026-11-23) — project scope: finance:read reaches every
 * project; anyone else needs project access too (finance-scope.ts).
 *
 * Permissions round 2 (B-12 / B-13) — contract money.
 *   Read:  `totalAmount` / `unitPrice` are stripped by the global
 *          interceptor; ContractItem `total` / `quantity` and
 *          Billing / LabelMilestone / Expense `amount` are ambiguous
 *          names, stripped here for callers without finance:read.
 *   Write: changing any of them needs finance:write (unchanged echoes
 *          pass).
 */
function redactContractMoney<T extends Record<string, any>>(contract: T): T {
  if (!contract || typeof contract !== 'object') return contract;
  const out: Record<string, any> = omitKeys(contract, ['totalAmount']);
  if (Array.isArray(out.items)) out.items = omitKeys(out.items, CONTRACT_ITEM_MONEY_KEYS);
  if (Array.isArray(out.billings)) out.billings = omitKeys(out.billings, AMOUNT_KEYS);
  return out as T;
}

@ApiTags('Contracts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly contractsService: ContractsService,
    private readonly access: ProjectAccessService,
  ) {}

  private scope(user: any, projectId: number | null | undefined) {
    return assertFinanceProjectAccess(this.access, user, projectId);
  }

  @Post()
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create a contract' })
  async create(@CurrentUser() user: any, @Body() dto: CreateContractDto) {
    await this.scope(user, dto.projectId);
    await assertFinanceFieldWrites(user, dto, ['totalAmount'], null);
    return this.contractsService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List contracts with filters' })
  async findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
    @Query('projectId') projectId?: number,
    @Query('partnerId') partnerId?: number,
  ) {
    if (projectId) await this.scope(user, Number(projectId));
    const projectIds = projectId ? null : await financeProjectScope(this.access, user);
    return this.contractsService.findAll({ page, perPage, status, projectId, partnerId }, projectIds);
  }

  @Get(':id')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'Get contract by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.scope(user, await this.contractsService.getContractProjectId(id));
    const contract = await this.contractsService.findOne(id);
    return canSeeFinance(user) ? contract : redactContractMoney(contract);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update a contract' })
  async update(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateContractDto>,
  ) {
    await this.scope(user, await this.contractsService.getContractProjectId(id));
    // Moving the contract to another project needs access there too.
    if (dto.projectId !== undefined) await this.scope(user, dto.projectId);
    await assertFinanceFieldWrites(user, dto, ['totalAmount'], () => this.contractsService.findOne(id));
    return this.contractsService.update(id, dto, user.id);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a contract' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.scope(user, await this.contractsService.getContractProjectId(id));
    return this.contractsService.remove(id, user.id);
  }

  // Contract Items
  @Post(':id/items')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Add item to contract' })
  async addItem(@CurrentUser() user: any, @Param('id', ParseIntPipe) contractId: number, @Body() body: any) {
    await this.scope(user, await this.contractsService.getContractProjectId(contractId));
    // `quantity` defaults to 1 on create — echoing the default is no change.
    await assertFinanceFieldWrites(user, body, CONTRACT_ITEM_MONEY_KEYS, { quantity: 1 });
    const item = await this.contractsService.addItem(contractId, body);
    return canSeeFinance(user) ? item : omitKeys(item, CONTRACT_ITEM_MONEY_KEYS);
  }

  @Patch(':id/items/:itemId')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update contract item' })
  async updateItem(
    @CurrentUser() user: any,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: any,
  ) {
    await this.scope(user, await this.contractsService.getItemProjectId(itemId));
    await assertFinanceFieldWrites(user, body, CONTRACT_ITEM_MONEY_KEYS, () =>
      this.contractsService.getItem(itemId),
    );
    const item = await this.contractsService.updateItem(itemId, body);
    return canSeeFinance(user) ? item : omitKeys(item, CONTRACT_ITEM_MONEY_KEYS);
  }

  @Delete(':id/items/:itemId')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Remove contract item' })
  async removeItem(@CurrentUser() user: any, @Param('itemId', ParseIntPipe) itemId: number) {
    await this.scope(user, await this.contractsService.getItemProjectId(itemId));
    return this.contractsService.removeItem(itemId);
  }

  // Milestones
  @Post(':contractId/milestones')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create milestone for a label' })
  async createMilestone(@CurrentUser() user: any, @Body() body: any) {
    // The milestone's project is its label's project.
    await this.scope(user, await this.contractsService.getLabelProjectId(Number(body?.labelId)));
    await assertFinanceFieldWrites(user, body, AMOUNT_KEYS, null);
    const milestone = await this.contractsService.createMilestone(user.id, body);
    return canSeeFinance(user) ? milestone : omitKeys(milestone, AMOUNT_KEYS);
  }

  @Patch('milestones/:id')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update milestone' })
  async updateMilestone(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    await this.scope(user, await this.contractsService.getMilestoneProjectId(id));
    await assertFinanceFieldWrites(user, body, AMOUNT_KEYS, () => this.contractsService.getMilestone(id));
    const milestone = await this.contractsService.updateMilestone(id, body);
    return canSeeFinance(user) ? milestone : omitKeys(milestone, AMOUNT_KEYS);
  }

  @Delete('milestones/:id')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Delete milestone' })
  async removeMilestone(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.scope(user, await this.contractsService.getMilestoneProjectId(id));
    return this.contractsService.removeMilestone(id);
  }

  // Contacts
  @Post('contacts')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create contact for a partner' })
  createContact(@Body() body: any) {
    return this.contractsService.createContact(body);
  }

  @Get('contacts/:partnerId')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'Get contacts for a partner' })
  getContacts(@Param('partnerId', ParseIntPipe) partnerId: number) {
    return this.contractsService.getContacts(partnerId);
  }

  @Delete('contacts/:id')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Delete contact' })
  removeContact(@Param('id', ParseIntPipe) id: number) {
    return this.contractsService.removeContact(id);
  }

  // Expenses
  @Post('expenses')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create expense' })
  async createExpense(@CurrentUser() user: any, @Body() dto: CreateExpenseDto) {
    await this.scope(user, dto.projectId);
    await assertFinanceFieldWrites(user, dto, AMOUNT_KEYS, null);
    const expense = await this.contractsService.createExpense(user.id, dto);
    return canSeeFinance(user) ? expense : omitKeys(expense, AMOUNT_KEYS);
  }

  @Get('expenses')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'List expenses by project' })
  async getExpenses(@CurrentUser() user: any, @Query('projectId', ParseIntPipe) projectId: number) {
    await this.scope(user, projectId);
    const expenses = await this.contractsService.getExpenses(projectId);
    return canSeeFinance(user) ? expenses : omitKeys(expenses, AMOUNT_KEYS);
  }

  // `POST /contracts/terms` and `GET /contracts/terms/:userId` were
  // removed in permissions round 2 (B-05 / B-14): they read and wrote
  // `Term.monthlySalary` / `Term.hourlyRate` for ANY user behind plain
  // contracts:read / contracts:write, and nothing in the web called them.
}
