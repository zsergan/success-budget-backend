import {
  applyDecorators,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import {
  CreateTransactionResult,
  TransactionCount,
  TransactionOperationView,
  TransactionView,
  UpdateTransactionResult,
} from './dto/transaction-responses';
import type { AuthedRequest } from '@shared/types';
import { TransactionKind, TransactionType } from '@shared/enums';
import { getEndOfMonth, getStartOfMonth } from '@shared/utils';
import { ParseOptionalDatePipe } from '@shared/pipes/parse-optional-date.pipe';
import { ParseOptionalEnumPipe } from '@shared/pipes/parse-optional-enum.pipe';
import { ParseOptionalIdPipe } from '@shared/pipes/parse-optional-id.pipe';
import { ParseIfMatchVersionPipe } from '@shared/pipes/parse-if-match-version.pipe';
import { ParseIdempotencyKeyPipe } from '@shared/pipes/parse-idempotency-key.pipe';
import { RequestHeader } from '@shared/decorators/request-header.decorator';

const IDEMPOTENCY_KEY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'A client-generated key, e.g. a UUID. A repeat with the same key and request within 24 hours ' +
    'returns the original result instead of applying the write again.',
};

// the list and its count take the same query
const ApiHistoryQuery = () =>
  applyDecorators(
    ApiQuery({
      name: 'from',
      required: false,
      description: 'Inclusive; without Z/offset it is server local time. Default: start of the current month.',
    }),
    ApiQuery({ name: 'to', required: false, description: 'Inclusive, to the millisecond. Default: end of the month.' }),
    ApiQuery({ name: 'transaction_type', required: false, enum: TransactionType }),
    ApiQuery({
      name: 'kind',
      required: false,
      enum: TransactionKind,
      description: 'regular leaves out starting balances; initial_balance lists only them.',
    }),
    ApiQuery({
      name: 'category_id',
      required: false,
      type: Number,
      description: 'A category of the space, archived allowed; the system one is refused.',
    }),
    ApiQuery({ name: 'wallet_id', required: false, type: Number, description: 'An active wallet of the space.' }),
  );

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('spaces/:spaceId/transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiCreatedResponse({ type: CreateTransactionResult })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, WALLET_DELETED, CATEGORY_ARCHIVED or CATEGORY_TYPE_MISMATCH.',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN_SPACE, FORBIDDEN_WALLET or FORBIDDEN_CATEGORY.' })
  @ApiConflictResponse({
    description:
      'IDEMPOTENCY_KEY_REUSED: the key was used for a different request. ' +
      'TRANSACTION_OPERATION_EXISTS: client_operation_id was already used; GET /operations/:id tells the result.',
  })
  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createTransactionDto: CreateTransactionDto,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ) {
    return this.transactionsService.create(req.user.id, spaceId, createTransactionDto, { idempotencyKey });
  }

  @ApiOkResponse({ type: TransactionView, description: 'Empty body when the space has no transactions.' })
  @Get('latest')
  async getLatest(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    return this.transactionsService.getLatest(req.user.id, spaceId);
  }

  @ApiHistoryQuery()
  @ApiOkResponse({ type: TransactionCount, description: 'The number of rows GET /transactions returns.' })
  @Get('count')
  async count(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('from', ParseOptionalDatePipe) from: Date = getStartOfMonth(new Date()),
    @Query('to', ParseOptionalDatePipe) to: Date = getEndOfMonth(new Date()),
    @Query('transaction_type', new ParseOptionalEnumPipe(TransactionType)) transactionType?: TransactionType,
    @Query('kind', new ParseOptionalEnumPipe(TransactionKind)) kind?: TransactionKind,
    @Query('category_id', ParseOptionalIdPipe) categoryId?: number,
    @Query('wallet_id', ParseOptionalIdPipe) walletId?: number,
  ) {
    return this.transactionsService.count(req.user.id, spaceId, from, to, {
      transactionType,
      kind,
      categoryId,
      walletId,
    });
  }

  @ApiOkResponse({ type: TransactionOperationView })
  @ApiNotFoundResponse({
    description: 'TRANSACTION_OPERATION_NOT_FOUND: no create with this client_operation_id committed in the space.',
  })
  @Get('operations/:operationId')
  async getOperation(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('operationId') operationId: string,
  ): Promise<TransactionOperationView> {
    return this.transactionsService.getOperation(req.user.id, spaceId, operationId);
  }

  @ApiHistoryQuery()
  @ApiOkResponse({ type: TransactionView, isArray: true })
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('from', ParseOptionalDatePipe) from: Date = getStartOfMonth(new Date()),
    @Query('to', ParseOptionalDatePipe) to: Date = getEndOfMonth(new Date()),
    @Query('transaction_type', new ParseOptionalEnumPipe(TransactionType)) transactionType?: TransactionType,
    @Query('kind', new ParseOptionalEnumPipe(TransactionKind)) kind?: TransactionKind,
    @Query('category_id', ParseOptionalIdPipe) categoryId?: number,
    @Query('wallet_id', ParseOptionalIdPipe) walletId?: number,
  ) {
    return this.transactionsService.getAll(req.user.id, spaceId, from, to, {
      transactionType,
      kind,
      categoryId,
      walletId,
    });
  }

  @ApiOkResponse({ type: TransactionView })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND: missing, malformed id, or of another space.' })
  @Get(':transactionId')
  async getById(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
  ): Promise<TransactionView> {
    return this.transactionsService.getById(req.user.id, spaceId, transactionId);
  }

  @ApiHeader({ name: 'If-Match', required: true, description: 'The version the client read, e.g. "3".' })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiOkResponse({ type: UpdateTransactionResult })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, TRANSACTION_IS_SYSTEM, WALLET_DELETED, CATEGORY_ARCHIVED or CATEGORY_TYPE_MISMATCH.',
  })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND: missing, malformed id, or of another space.' })
  @ApiConflictResponse({ description: 'TRANSACTION_VERSION_CONFLICT or IDEMPOTENCY_KEY_REUSED.' })
  @ApiResponse({ status: 428, description: 'TRANSACTION_VERSION_REQUIRED: If-Match is missing.' })
  @Patch(':transactionId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
    @Body() updateTransactionDto: UpdateTransactionDto,
    @RequestHeader('If-Match', ParseIfMatchVersionPipe) expectedVersion?: number,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ): Promise<UpdateTransactionResult> {
    return this.transactionsService.update(req.user.id, spaceId, transactionId, updateTransactionDto, {
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
  @ApiConflictResponse({
    description:
      'TRANSACTION_VERSION_CONFLICT: If-Match differs from the stored version. ' +
      'IDEMPOTENCY_KEY_REUSED: the key was used for a different request.',
  })
  @Delete(':transactionId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
    @RequestHeader('If-Match', ParseIfMatchVersionPipe) expectedVersion?: number,
    @RequestHeader('Idempotency-Key', ParseIdempotencyKeyPipe) idempotencyKey?: string,
  ): Promise<boolean> {
    await this.transactionsService.remove(req.user.id, spaceId, transactionId, { expectedVersion, idempotencyKey });

    return true;
  }
}
