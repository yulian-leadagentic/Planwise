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
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { CreateContractDto } from './dto/create-contract.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';

@ApiTags('Contracts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Post()
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create a contract' })
  create(@CurrentUser() user: any, @Body() dto: CreateContractDto) {
    return this.contractsService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List contracts with filters' })
  findAll(
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
    @Query('projectId') projectId?: number,
    @Query('partnerId') partnerId?: number,
  ) {
    return this.contractsService.findAll({ page, perPage, status, projectId, partnerId });
  }

  @Get(':id')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'Get contract by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.contractsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update a contract' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateContractDto>) {
    return this.contractsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a contract' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.contractsService.remove(id);
  }

  // Contract Items
  @Post(':id/items')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Add item to contract' })
  addItem(@Param('id', ParseIntPipe) contractId: number, @Body() body: any) {
    return this.contractsService.addItem(contractId, body);
  }

  @Patch(':id/items/:itemId')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update contract item' })
  updateItem(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: any,
  ) {
    return this.contractsService.updateItem(itemId, body);
  }

  @Delete(':id/items/:itemId')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Remove contract item' })
  removeItem(@Param('itemId', ParseIntPipe) itemId: number) {
    return this.contractsService.removeItem(itemId);
  }

  // Milestones
  @Post(':contractId/milestones')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create milestone for a label' })
  createMilestone(@CurrentUser() user: any, @Body() body: any) {
    return this.contractsService.createMilestone(user.id, body);
  }

  @Patch('milestones/:id')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update milestone' })
  updateMilestone(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.contractsService.updateMilestone(id, body);
  }

  @Delete('milestones/:id')
  @RequirePermissions({ module: 'contracts', action: 'delete' })
  @ApiOperation({ summary: 'Delete milestone' })
  removeMilestone(@Param('id', ParseIntPipe) id: number) {
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
  createExpense(@CurrentUser() user: any, @Body() dto: CreateExpenseDto) {
    return this.contractsService.createExpense(user.id, dto);
  }

  @Get('expenses')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'List expenses by project' })
  getExpenses(@Query('projectId', ParseIntPipe) projectId: number) {
    return this.contractsService.getExpenses(projectId);
  }

  // Terms
  @Post('terms')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create employment/contract term' })
  createTerm(@Body() body: any) {
    return this.contractsService.createTerm(body);
  }

  @Get('terms/:userId')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'Get terms for a user' })
  getTerms(@Param('userId', ParseIntPipe) userId: number) {
    return this.contractsService.getTerms(userId);
  }
}
