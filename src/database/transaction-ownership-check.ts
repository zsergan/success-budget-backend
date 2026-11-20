import { readFileSync, writeFileSync } from 'fs';

import dataSource from '@config/typeorm-cli.data-source';
import {
  type TransactionLedger,
  compareLedgers,
  findMisplacedTransactions,
  findOwnershipProblems,
  hasOwnershipProblems,
  readOwnershipInvariants,
  readOwnershipSchema,
  readTransactionLedger,
} from './transaction-ownership';

// Deploy steps around the migrations that changed who owns a transaction,
// during their write pause (docs/deployment.md#rolling-out-space-owned-transactions,
// docs/deployment.md#rolling-out-the-removal-of-wallets):
//   preflight        records the next of them would refuse; exits 1 if any
//   snapshot <file>  writes the ledger of the history as it is now
//   verify <file>    compares the history with a snapshot taken before the
//                    migration and checks the ownership columns; exits 1 on a difference
// A <file> of "-" is stdout for snapshot and stdin for verify, so a
// container needs no volume; messages then go to stderr.
const USAGE = 'Usage: transaction-ownership-check (preflight | snapshot <file> | verify <file>)';

async function preflight(): Promise<boolean> {
  const { hasOwners, hasWallets } = await readOwnershipSchema(dataSource);

  if (!hasOwners) {
    const problems = await findOwnershipProblems(dataSource);

    if (!hasOwnershipProblems(problems)) {
      console.log('Preflight OK: every transaction has a wallet, a space and a member to be attributed to.');
      return true;
    }

    console.error('Preflight found records the migration would refuse to move:');
    console.error(JSON.stringify(problems, null, 2));
    return false;
  }

  if (!hasWallets) {
    console.log('Preflight OK: transactions belong to their spaces and no wallet is left.');
    return true;
  }

  const misplaced = await findMisplacedTransactions(dataSource);

  if (misplaced.length === 0) {
    console.log("Preflight OK: every transaction belongs to its wallet's space; the wallets can be dropped.");
    return true;
  }

  console.error(`Preflight found ${misplaced.length} transactions whose space_id differs from their wallet's space:`);
  console.error(JSON.stringify(misplaced, null, 2));
  return false;
}

const STANDARD_STREAM = '-';

async function snapshot(file: string): Promise<boolean> {
  const ledger = await readTransactionLedger(dataSource);
  const json = JSON.stringify(ledger, null, 2);

  if (file === STANDARD_STREAM) {
    process.stdout.write(`${json}\n`);
  } else {
    writeFileSync(file, json);
  }

  console.error(
    `Snapshot of ${ledger.transactions} transactions in ${ledger.spaces.length} spaces written to ${file}.`,
  );
  return true;
}

async function verify(file: string): Promise<boolean> {
  const before = JSON.parse(readFileSync(file === STANDARD_STREAM ? 0 : file, 'utf8')) as TransactionLedger;
  const after = await readTransactionLedger(dataSource);
  const differences = compareLedgers(before, after);
  const invariants = await readOwnershipInvariants(dataSource);
  // taken before the space-ownership migration, which gives every record an
  // author; later a missing author is a deleted account, compared as such
  const ownershipAdded = !before.spaces.some((space) => space.owners);

  if (invariants.misplaced) {
    differences.push(`${invariants.misplaced} transactions have a space_id other than their wallet's space`);
  }

  if (ownershipAdded && invariants.withoutAuthor) {
    differences.push(`${invariants.withoutAuthor} transactions have no author`);
  }

  if (invariants.inconsistentAssignments) {
    differences.push(`${invariants.inconsistentAssignments} transactions have a user on a non-member assignment`);
  }

  if (differences.length === 0) {
    console.log(
      `Reconciliation OK: ${after.transactions} transactions in ${after.spaces.length} spaces match ${file}.`,
    );
    return true;
  }

  console.error(`Reconciliation found ${differences.length} differences:`);
  differences.forEach((difference) => console.error(`- ${difference}`));
  return false;
}

async function run(): Promise<boolean> {
  const [command, file] = process.argv.slice(2);

  if (command === 'preflight') {
    return preflight();
  }

  if ((command === 'snapshot' || command === 'verify') && file) {
    return command === 'snapshot' ? snapshot(file) : verify(file);
  }

  console.error(USAGE);
  return false;
}

async function main() {
  await dataSource.initialize();

  try {
    if (!(await run())) {
      process.exitCode = 1;
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
