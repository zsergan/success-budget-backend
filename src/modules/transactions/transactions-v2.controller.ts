import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Request } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { SpaceTransactionsService } from './space-transactions.service';
import { CreateTransactionV2Dto, UpdateTransactionV2Dto } from './dto/transaction-v2.dto';
import {
  TransactionAssignees,
  TransactionFeedV2,
  TransactionOperationViewV2,
  TransactionResultV2,
  TransactionViewV2,
} from './dto/transaction-v2-responses';
import { TransactionCountQueryV2Dto, TransactionFeedQueryV2Dto } from './dto/transaction-feed-query-v2.dto';
import { TransactionCount } from './dto/transaction-responses';
import type { AuthedRequest } from '@shared/types';
import { ParseIfMatchVersionPipe } from '@shared/pipes/parse-if-match-version.pipe';
import { ParseIdempotencyKeyPipe } from '@shared/pipes/parse-idempotency-key.pipe';
import { RequestHeader } from '@shared/decorators/request-header.decorator';

const CONTRACT = 'See docs/transactions-v2-contract.md.';

const IDEMPOTENCY_KEY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'A client-generated key, e.g. a UUID. A repeat with the same key and request within 24 hours returns the ' +
    'original result. Keys of v2 writes are apart from v1 keys.',
};

@ApiTags('transactions v2')
@ApiBearerAuth()
@Controller({ path: 'spaces/:spaceId/transactions', version: '2' })
export class TransactionsV2Controller {
  constructor(private readonly spaceTransactionsService: SpaceTransactionsService) {}

  @ApiOperation({ summary: 'Create a transaction of the space, by the caller, for a member, the space or nobody' })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiCreatedResponse({ type: TransactionResultV2 })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, CATEGORY_ARCHIVED, CATEGORY_TYPE_MISMATCH or ASSIGNEE_NOT_MEMBER.',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN_SPACE or FORBIDDEN_CATEGORY.' })
  @ApiConflictResponse({
    description:
      'IDEMPOTENCY_KEY_REUSED: the key was used for a different request. ' +
      'TRANSACTION_OPERATION_EXISTS: client_operation_id was already used, through either version.',
  })
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() dto: CreateTransactionV2Dto,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ): Promise<TransactionResultV2> {
    return this.spaceTransactionsService.create(req.user.id, spaceId, dto, { idempotencyKey });
  }

  @ApiOperation({
    summary: 'The transaction list, one page at a time, filtered by assignment among others',
    description:
      'Newest first (timestamp, then id). summary and day_totals cover the whole selection, assignment ' +
      `included. Search matches descriptions and category names. ${CONTRACT}`,
  })
  @ApiOkResponse({ type: TransactionFeedV2 })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED: a malformed parameter, from after to, cursor with around_id, or a cursor of another ' +
      'query or API version.',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN_SPACE, FORBIDDEN_CATEGORY or FORBIDDEN_MEMBER.' })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND or TRANSACTION_NOT_IN_FEED for around_id.' })
  @Get('feed')
  async getFeed(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: TransactionFeedQueryV2Dto,
  ): Promise<TransactionFeedV2> {
    return this.spaceTransactionsService.getFeed(req.user.id, spaceId, query);
  }

  @ApiOkResponse({ type: TransactionCount, description: 'The feed summary.count for the same period, q and filters.' })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: a malformed parameter or from after to.' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN_SPACE, FORBIDDEN_CATEGORY or FORBIDDEN_MEMBER.' })
  @Get('count')
  async count(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: TransactionCountQueryV2Dto,
  ): Promise<TransactionCount> {
    return this.spaceTransactionsService.count(req.user.id, spaceId, query);
  }

  @ApiOperation({ summary: 'The options of the History "Assigned to" filter', description: CONTRACT })
  @ApiOkResponse({ type: TransactionAssignees })
  @Get('assignees')
  async getAssignees(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
  ): Promise<TransactionAssignees> {
    return this.spaceTransactionsService.getAssignees(req.user.id, spaceId);
  }

  @ApiOkResponse({ type: TransactionViewV2, description: 'Empty body when the space has no transactions.' })
  @Get('latest')
  async getLatest(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    return this.spaceTransactionsService.getLatest(req.user.id, spaceId);
  }

  @ApiOperation({ summary: 'What became of a create with this client_operation_id', description: CONTRACT })
  @ApiOkResponse({ type: TransactionOperationViewV2 })
  @ApiNotFoundResponse({
    description: 'TRANSACTION_OPERATION_NOT_FOUND: no create with this client_operation_id committed in the space.',
  })
  @Get('operations/:operationId')
  async getOperation(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('operationId') operationId: string,
  ): Promise<TransactionOperationViewV2> {
    return this.spaceTransactionsService.getOperation(req.user.id, spaceId, operationId);
  }

  @ApiOkResponse({ type: TransactionViewV2 })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND: missing, malformed id, or of another space.' })
  @Get(':transactionId')
  async getById(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
  ): Promise<TransactionViewV2> {
    return this.spaceTransactionsService.getById(req.user.id, spaceId, transactionId);
  }

  @ApiOperation({ summary: 'Edit a transaction; the author never changes', description: CONTRACT })
  @ApiHeader({ name: 'If-Match', required: true, description: 'The version the client read, e.g. "3".' })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiOkResponse({ type: TransactionResultV2 })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, TRANSACTION_IS_SYSTEM, CATEGORY_ARCHIVED, CATEGORY_TYPE_MISMATCH or ASSIGNEE_NOT_MEMBER.',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN_SPACE or FORBIDDEN_CATEGORY.' })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND: missing, malformed id, or of another space.' })
  @ApiConflictResponse({ description: 'TRANSACTION_VERSION_CONFLICT or IDEMPOTENCY_KEY_REUSED.' })
  @ApiResponse({ status: 428, description: 'TRANSACTION_VERSION_REQUIRED: If-Match is missing.' })
  @Patch(':transactionId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
    @Body() dto: UpdateTransactionV2Dto,
    @RequestHeader('If-Match', ParseIfMatchVersionPipe) expectedVersion?: number,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ): Promise<TransactionResultV2> {
    return this.spaceTransactionsService.update(req.user.id, spaceId, transactionId, dto, {
      expectedVersion,
      idempotencyKey,
    });
  }

  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'The version the client read, e.g. "3"; for an undo, the version from the POST result.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiOkResponse({ type: Boolean })
  @ApiBadRequestResponse({ description: 'TRANSACTION_IS_SYSTEM: the initial balance cannot be deleted.' })
  @ApiResponse({ status: 428, description: 'TRANSACTION_VERSION_REQUIRED: If-Match is missing.' })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND: missing, malformed id, or of another space.' })
  @ApiConflictResponse({ description: 'TRANSACTION_VERSION_CONFLICT or IDEMPOTENCY_KEY_REUSED.' })
  @Delete(':transactionId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
    @RequestHeader('If-Match', ParseIfMatchVersionPipe) expectedVersion?: number,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ): Promise<boolean> {
    await this.spaceTransactionsService.remove(req.user.id, spaceId, transactionId, {
      expectedVersion,
      idempotencyKey,
    });

    return true;
  }
}
