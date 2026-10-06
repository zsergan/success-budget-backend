import { ApiExtraModels, ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';

import { AppColor, CategoryIcon, TransactionKind, TransactionType } from '@shared/enums';
import { nullableObject } from '@shared/swagger';

// Every property is decorated explicitly and the file has no .dto.ts suffix,
// so the CLI plugin adds nothing and the schema is the same in tests.

const INSTANT: ApiPropertyOptions = { type: String, format: 'date-time', example: '2026-09-28T12:00:00.000Z' };

export class TransactionWallet {
  @ApiProperty({ type: 'integer', example: 7 })
  id!: number;

  @ApiProperty({ example: 'Cash' })
  wallet_name!: string;

  @ApiProperty({ enum: AppColor, enumName: 'AppColor' })
  design!: AppColor;

  @ApiProperty(INSTANT)
  created_at!: Date;

  @ApiProperty(INSTANT)
  updated_at!: Date;
}

// Not the Categories API item: only what a transaction row needs.
export class TransactionCategory {
  @ApiProperty({ type: 'integer', example: 12 })
  id!: number;

  @ApiProperty({ example: 'Grocery' })
  name!: string;

  @ApiProperty({ enum: TransactionType, enumName: 'TransactionType' })
  transaction_type!: TransactionType;

  @ApiProperty({ enum: CategoryIcon, enumName: 'CategoryIcon' })
  icon!: string;

  @ApiProperty({ enum: AppColor, enumName: 'AppColor' })
  color!: AppColor;

  @ApiProperty({ type: 'integer', enum: [0, 1], description: 'Kept for compatibility; prefer is_archived.' })
  is_active!: number;

  @ApiProperty()
  is_archived!: boolean;

  @ApiProperty(INSTANT)
  created_at!: Date;

  @ApiProperty(INSTANT)
  updated_at!: Date;
}

@ApiExtraModels(TransactionWallet)
export class TransactionView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: TransactionKind,
    enumName: 'TransactionKind',
    description: 'initial_balance is a system record: readable, never edited or deleted as a transaction.',
  })
  kind!: TransactionKind;

  @ApiProperty({ enum: TransactionType, enumName: 'TransactionType' })
  transaction_type!: TransactionType;

  @ApiProperty({ pattern: '^\\d+\\.\\d{2}$', example: '12.30', description: 'Non-negative; type gives the sign.' })
  amount!: string;

  @ApiProperty(INSTANT)
  timestamp!: Date;

  @ApiProperty({ type: String, nullable: true, description: 'null when there is no description, never "".' })
  description!: string | null;

  @ApiProperty({ type: 'integer', minimum: 1, description: 'Bumped on every change of the record.' })
  version!: number;

  @ApiProperty(nullableObject(TransactionWallet, 'null when the wallet is deleted.'))
  wallet!: TransactionWallet | null;

  @ApiProperty({ type: TransactionCategory })
  category!: TransactionCategory;
}

export class TransactionWalletBalance {
  @ApiProperty({ type: 'integer', example: 7 })
  id!: number;

  @ApiProperty({ example: 120.5, description: 'Current balance, from the whole history.' })
  balance!: number;

  @ApiProperty()
  is_deleted!: boolean;
}

export class UpdateTransactionResult {
  @ApiProperty({ type: TransactionView, description: 'The stored state after the edit.' })
  transaction!: TransactionView;

  @ApiProperty({
    type: TransactionWalletBalance,
    isArray: true,
    description: 'Every wallet the edit touched: the old one first, then the new one when the wallet changed.',
  })
  wallets!: TransactionWalletBalance[];
}

export class TransactionCount {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Rows the list returns for the same query.' })
  count!: number;
}

export class TransactionWalletWithBalance extends TransactionWallet {
  @ApiProperty({ example: 87.7, description: 'Balance after the write, from the whole history.' })
  balance!: number;
}

export class CreateTransactionResult {
  @ApiProperty({ type: TransactionView, description: 'The stored record, as GET /:id reads it.' })
  transaction!: TransactionView;

  @ApiProperty({ type: TransactionWalletWithBalance })
  wallet!: TransactionWalletWithBalance;

  @ApiProperty({ example: 100, description: 'Balance before the transaction, from the whole history.' })
  previous_balance!: number;
}
