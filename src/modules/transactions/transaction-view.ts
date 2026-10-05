import type { Category } from '@entities/category.entity';
import type { Wallet } from '@entities/wallet.entity';
import type { LoadedTransaction } from '@modules/transaction-queries/transaction-queries.service';
import { TransactionKind } from '@shared/enums';
import type { TransactionCategory, TransactionView, TransactionWallet } from './dto/transaction-responses';

// Built field by field, so no entity column reaches the client unless listed.
export function toTransactionView(transaction: LoadedTransaction): TransactionView {
  return {
    id: transaction.id,
    kind: transaction.category.is_system ? TransactionKind.INITIAL_BALANCE : TransactionKind.REGULAR,
    transaction_type: transaction.transaction_type,
    amount: transaction.amount,
    timestamp: transaction.timestamp,
    description: transaction.description?.trim() ? transaction.description : null,
    version: transaction.version,
    wallet: transaction.wallet.is_deleted ? null : toWallet(transaction.wallet),
    category: toCategory(transaction.category),
  };
}

function toWallet(wallet: Wallet): TransactionWallet {
  return {
    id: wallet.id,
    wallet_name: wallet.wallet_name,
    design: wallet.design,
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
  };
}

function toCategory(category: Category): TransactionCategory {
  return {
    id: category.id,
    name: category.name,
    transaction_type: category.transaction_type,
    icon: category.icon,
    color: category.color,
    is_active: category.is_active,
    is_archived: !category.is_active,
    created_at: category.created_at,
    updated_at: category.updated_at,
  };
}
