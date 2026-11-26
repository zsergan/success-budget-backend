import { readFileSync, writeFileSync } from 'fs';

import dataSource from '@config/typeorm-cli.data-source';
import { type DateLedger, compareDateLedgers, readDateLedger, readDateSchema } from './transaction-dates';

// Deploy steps around ReplaceTransactionTimestampWithDate1791500000000,
// during its write pause (docs/deployment.md#rolling-out-calendar-dates):
//   snapshot <file>  before the migration: every record with the Chicago
//                    day of its instant, the history order, the day and
//                    month totals; exits 1 when the migration already ran
//   verify <file>    after it: the stored dates and order compared with the
//                    snapshot; exits 1 on a difference
// A <file> of "-" is stdout for snapshot and stdin for verify, so a
// container needs no volume; messages then go to stderr.
const USAGE = 'Usage: transaction-dates-check (snapshot <file> | verify <file>)';
const STANDARD_STREAM = '-';

async function snapshot(file: string): Promise<boolean> {
  if (!(await readDateSchema(dataSource)).hasTimestamp) {
    console.error('transactions.timestamp is gone: the migration already ran, a snapshot of it is meaningless.');
    return false;
  }

  const ledger = await readDateLedger(dataSource);
  const json = JSON.stringify(ledger, null, 2);

  if (file === STANDARD_STREAM) {
    process.stdout.write(`${json}\n`);
  } else {
    writeFileSync(file, json);
  }

  console.error(
    `Snapshot of ${ledger.transactions} transactions in ${ledger.spaces.length} spaces, ` +
      `${ledger.days.length} space days, written to ${file}.`,
  );
  return true;
}

async function verify(file: string): Promise<boolean> {
  const before = JSON.parse(readFileSync(file === STANDARD_STREAM ? 0 : file, 'utf8')) as DateLedger;
  const after = await readDateLedger(dataSource);
  const differences = compareDateLedgers(before, after);

  if (differences.length === 0) {
    console.log(
      `Reconciliation OK: ${after.transactions} transactions in ${after.spaces.length} spaces keep their Chicago ` +
        `days, order, ${after.days.length} day totals and ${after.months.length} month totals.`,
    );
    return true;
  }

  console.error(`Reconciliation found ${differences.length} differences:`);
  differences.forEach((difference) => console.error(`- ${difference}`));
  return false;
}

async function run(): Promise<boolean> {
  const [command, file] = process.argv.slice(2);

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
