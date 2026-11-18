import type { EntityManager } from 'typeorm';

import { Wallet } from '@entities/wallet.entity';
import { AppColor } from '@shared/enums';
import { LockSetChanged, isDuplicateKey, lockRows } from '@shared/utils';

// Release A only: v2 records are kept in one active wallet of their space,
// so that v1 clients read them through wallets. v2 never shows it.
export const COMPATIBILITY_WALLET_NAME = 'Shared transactions';
const COMPATIBILITY_WALLET_KEY = 'UQ_wallets_compat_space';

// The space's compatibility wallet, locked exclusively like any wallet a
// write changes; created on the first v2 create of the space, or after a v1
// client deleted it. Of two concurrent creators, the second waits on the
// unique key and then runs its unit again, which finds the first one's.
export async function lockCompatibilityWallet(manager: EntityManager, spaceId: number): Promise<Wallet> {
  const repository = manager.getRepository(Wallet);
  const existing = await repository.findOne({ select: { id: true }, where: { compat_space_id: spaceId } });

  if (existing) {
    const [locked] = await lockRows(manager, Wallet, [existing.id], 'exclusive');

    // deleted, and so unmarked, between the read and the lock
    if (locked?.compat_space_id !== spaceId) {
      throw new LockSetChanged();
    }

    return locked;
  }

  try {
    return await repository.save(
      repository.create({
        space_id: spaceId,
        wallet_name: COMPATIBILITY_WALLET_NAME,
        design: AppColor.SLATE,
        compat_space_id: spaceId,
      }),
    );
  } catch (error) {
    if (isDuplicateKey(error, COMPATIBILITY_WALLET_KEY)) {
      throw new LockSetChanged();
    }

    throw error;
  }
}
