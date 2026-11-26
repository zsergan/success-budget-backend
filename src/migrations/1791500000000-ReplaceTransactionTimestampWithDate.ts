import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  LEGACY_TIME_ZONE,
  assertLegacyZoneData,
  legacyDateOf,
  legacyDayStart,
  nextDate,
} from '../database/legacy-transaction-dates';

const BATCH = 1000;
const REPORTED = 20;
const ORDER_KEY_INDEX = 'UQ_transactions_order_key';
const DATE_INDEXES: Record<string, string> = {
  IDX_transactions_space_date:
    '`space_id`, `date`, `order_key`, `category_id`, `transaction_type`, `amount`, `assignment_kind`, `assigned_user_id`',
  IDX_transactions_space_assignment_date:
    '`space_id`, `assignment_kind`, `assigned_user_id`, `date`, `order_key`, `category_id`, `transaction_type`, `amount`',
};
const TIMESTAMP_INDEXES: Record<string, string> = {
  IDX_transactions_space_timestamp_id:
    '`space_id`, `timestamp`, `id`, `category_id`, `transaction_type`, `amount`, `assignment_kind`, `assigned_user_id`',
  IDX_transactions_space_assignment:
    '`space_id`, `assignment_kind`, `assigned_user_id`, `timestamp`, `id`, `category_id`, `transaction_type`, `amount`',
};
// the stored results that embed a transaction view
const TRANSACTION_RESULTS = "`operation` LIKE 'transactions.%'";
const EPOCH_MS = 'CAST(ROUND(UNIX_TIMESTAMP(`timestamp`) * 1000) AS SIGNED)';
// what a TIMESTAMP(3) holds, for down()
const TIMESTAMP_MIN_MS = Date.parse('1970-01-01T00:00:01.000Z');
const TIMESTAMP_MAX_MS = Date.parse('2038-01-19T03:14:07.999Z');

interface ColumnState {
  nullable: boolean;
  autoIncrement: boolean;
}

const listed = (ids: string[]) =>
  ids.length > REPORTED ? `${ids.slice(0, REPORTED).join(', ')} and ${ids.length - REPORTED} more` : ids.join(', ');

/**
 * Release C (docs/transactions-v2-contract.md#calendar-dates-release-c):
 * a transaction has a calendar date, no instant. Every record gets the
 * Chicago day of its timestamp, computed here with Luxon, never with a
 * fixed offset or the host's or the session's zone, and an ordering key
 * (AUTO_INCREMENT, so later inserts follow) in the old (timestamp, id)
 * order. Retained idempotency results get the same date in place of their
 * timestamp. The timestamp column goes last, after the dates passed the
 * check against the old day bounds.
 *
 * MySQL commits each ALTER TABLE on its own, so every step checks what an
 * interrupted run already did, and a run again finishes the change. It
 * runs in a write pause: the previous build cannot write on the result.
 */
export class ReplaceTransactionTimestampWithDate1791500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    assertLegacyZoneData();

    let columns = await this.columns(queryRunner);
    const added = [
      !columns.has('date') && 'ADD `date` date NULL AFTER `amount`',
      !columns.has('order_key') && 'ADD `order_key` bigint unsigned NULL AFTER `date`',
    ].filter(Boolean);

    if (added.length) {
      await queryRunner.query(`ALTER TABLE \`transactions\` ${added.join(', ')}`);
      columns = await this.columns(queryRunner);
    }

    const date = columns.get('date')!;
    const orderKey = columns.get('order_key')!;

    if (columns.has('timestamp')) {
      if (date.nullable) {
        await this.backfillDates(queryRunner);
      }

      if (!orderKey.autoIncrement) {
        await this.backfillOrderKeys(queryRunner);
      }

      await this.reconcile(queryRunner);
    }

    const hasOrderKeyIndex = await this.hasIndex(queryRunner, ORDER_KEY_INDEX);
    const finished = [
      date.nullable && 'MODIFY `date` date NOT NULL',
      !orderKey.autoIncrement && 'MODIFY `order_key` bigint unsigned NOT NULL AUTO_INCREMENT',
      !hasOrderKeyIndex && `ADD UNIQUE INDEX \`${ORDER_KEY_INDEX}\` (\`order_key\`)`,
    ].filter(Boolean);

    if (finished.length) {
      await queryRunner.query(`ALTER TABLE \`transactions\` ${finished.join(', ')}`);
    }

    for (const [name, keys] of Object.entries(DATE_INDEXES)) {
      if (!(await this.hasIndex(queryRunner, name))) {
        await queryRunner.query(`ALTER TABLE \`transactions\` ADD INDEX \`${name}\` (${keys})`);
      }
    }

    for (const name of Object.keys(TIMESTAMP_INDEXES)) {
      if (await this.hasIndex(queryRunner, name)) {
        await queryRunner.query(`ALTER TABLE \`transactions\` DROP INDEX \`${name}\``);
      }
    }

    await this.convertStoredResults(queryRunner, '$.transaction.timestamp', (timestamp, id) => {
      const epoch = Date.parse(timestamp);

      if (Number.isNaN(epoch)) {
        throw new Error(`Idempotency record ${id} holds a transaction timestamp that is not an instant: ${timestamp}`);
      }

      return { path: '$.transaction.date', value: legacyDateOf(epoch) };
    });

    if (columns.has('timestamp')) {
      await queryRunner.query('ALTER TABLE `transactions` DROP COLUMN `timestamp`');
    }
  }

  // Each record gets the first instant of its Chicago day, plus a
  // millisecond per record before it on that day, so the previous build
  // lists them in the same order. The times of day from before up() come
  // back only with the backup.
  public async down(queryRunner: QueryRunner): Promise<void> {
    assertLegacyZoneData();
    let columns = await this.columns(queryRunner);

    if (columns.has('date')) {
      await this.assertDatesFitTimestamps(queryRunner);
    }

    const [{ zone }]: { zone: string }[] = await queryRunner.query('SELECT @@session.time_zone AS zone');
    await queryRunner.query("SET time_zone = '+00:00'");

    try {
      if (!columns.has('timestamp')) {
        await queryRunner.query('ALTER TABLE `transactions` ADD `timestamp` timestamp(3) NULL AFTER `amount`');
        columns = await this.columns(queryRunner);
      }

      if (columns.has('date') && columns.get('timestamp')!.nullable) {
        await this.restoreTimestamps(queryRunner);
        await queryRunner.query(
          'ALTER TABLE `transactions` MODIFY `timestamp` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
        );
      }

      for (const [name, keys] of Object.entries(TIMESTAMP_INDEXES)) {
        if (!(await this.hasIndex(queryRunner, name))) {
          await queryRunner.query(`ALTER TABLE \`transactions\` ADD INDEX \`${name}\` (${keys})`);
        }
      }

      // the unique key of order_key goes with the column: an AUTO_INCREMENT column needs it
      for (const name of Object.keys(DATE_INDEXES)) {
        if (await this.hasIndex(queryRunner, name)) {
          await queryRunner.query(`ALTER TABLE \`transactions\` DROP INDEX \`${name}\``);
        }
      }

      await this.convertStoredResults(queryRunner, '$.transaction.date', (date) => ({
        path: '$.transaction.timestamp',
        value: new Date(legacyDayStart(date)).toISOString(),
      }));

      const dropped = [
        columns.has('order_key') && 'DROP COLUMN `order_key`',
        columns.has('date') && 'DROP COLUMN `date`',
      ].filter(Boolean);

      if (dropped.length) {
        await queryRunner.query(`ALTER TABLE \`transactions\` ${dropped.join(', ')}`);
      }
    } finally {
      await queryRunner.query('SET time_zone = ?', [zone]);
    }
  }

  // UNIX_TIMESTAMP of a TIMESTAMP column is its stored UTC value, whatever
  // the session's zone.
  private async backfillDates(queryRunner: QueryRunner): Promise<void> {
    for (let after = ''; ;) {
      const rows: { id: string; epoch_ms: string | number }[] = await queryRunner.query(
        `SELECT \`id\`, ${EPOCH_MS} AS epoch_ms FROM \`transactions\` WHERE \`id\` > ? ORDER BY \`id\` LIMIT ${BATCH}`,
        [after],
      );
      const byDate = new Map<string, string[]>();
      const invalid: string[] = [];

      for (const row of rows) {
        const epoch = Number(row.epoch_ms);

        if (!(epoch > 0)) {
          invalid.push(row.id);
          continue;
        }

        const date = legacyDateOf(epoch);
        byDate.set(date, [...(byDate.get(date) ?? []), row.id]);
      }

      if (invalid.length) {
        throw new Error(`Cannot date transactions with an invalid timestamp: ${listed(invalid)}.`);
      }

      for (const [date, ids] of byDate) {
        await queryRunner.query('UPDATE `transactions` SET `date` = ? WHERE `id` IN (?)', [date, ids]);
      }

      if (rows.length < BATCH) {
        return;
      }

      after = rows[rows.length - 1].id;
    }
  }

  private async backfillOrderKeys(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE \`transactions\` t
      INNER JOIN (
        SELECT \`id\`, ROW_NUMBER() OVER (ORDER BY ${EPOCH_MS}, \`id\`) AS position FROM \`transactions\`
      ) o ON o.\`id\` = t.\`id\`
      SET t.\`order_key\` = o.position
    `);
  }

  // Checked against the old reading, the day bounds of each date in
  // Chicago, independently of how the dates were computed: every record
  // lies within its day, so every day and month total is what the old
  // Chicago history showed. The ordering keys follow (timestamp, id).
  private async reconcile(queryRunner: QueryRunner): Promise<void> {
    const [missing]: { count: string | number }[] = await queryRunner.query(
      'SELECT COUNT(*) AS count FROM `transactions` WHERE `date` IS NULL OR `order_key` IS NULL',
    );

    if (Number(missing.count)) {
      throw new Error(`${missing.count} transactions have no date or ordering key after the backfill.`);
    }

    const days: { date: string; first_ms: string | number; last_ms: string | number }[] = await queryRunner.query(
      `SELECT DATE_FORMAT(\`date\`, '%Y-%m-%d') AS date, MIN(${EPOCH_MS}) AS first_ms, MAX(${EPOCH_MS}) AS last_ms
       FROM \`transactions\` GROUP BY \`date\` ORDER BY \`date\``,
    );
    const outside = days
      .filter(
        (day) =>
          Number(day.first_ms) < legacyDayStart(day.date) || Number(day.last_ms) >= legacyDayStart(nextDate(day.date)),
      )
      .map((day) => day.date);

    if (outside.length) {
      throw new Error(
        `Transactions dated ${listed(outside)} have instants outside that day in ${LEGACY_TIME_ZONE}; ` +
          'the timestamps are kept, and the migration can run again.',
      );
    }

    const [order]: { count: string | number; distinct_keys: string | number; out_of_order: string | number }[] =
      await queryRunner.query(`
        SELECT COUNT(*) AS count, COUNT(DISTINCT \`order_key\`) AS distinct_keys,
               SUM(CASE WHEN previous_key >= \`order_key\` THEN 1 ELSE 0 END) AS out_of_order
        FROM (
          SELECT \`order_key\`, LAG(\`order_key\`) OVER (ORDER BY ${EPOCH_MS}, \`id\`) AS previous_key
          FROM \`transactions\`
        ) ordered
      `);

    if (Number(order.distinct_keys) !== Number(order.count) || Number(order.out_of_order ?? 0) > 0) {
      throw new Error('The ordering keys do not follow the order of the timestamps; the migration can run again.');
    }
  }

  private async assertDatesFitTimestamps(queryRunner: QueryRunner): Promise<void> {
    const [range]: { first: string | null; last: string | null }[] = await queryRunner.query(
      "SELECT DATE_FORMAT(MIN(`date`), '%Y-%m-%d') AS first, DATE_FORMAT(MAX(`date`), '%Y-%m-%d') AS last FROM `transactions`",
    );

    if (range.first === null || range.last === null) {
      return;
    }

    const fits = (date: string) => legacyDayStart(date) >= TIMESTAMP_MIN_MS && legacyDayStart(date) < TIMESTAMP_MAX_MS;

    if (!fits(range.first) || !fits(range.last)) {
      const dates: { date: string }[] = await queryRunner.query(
        "SELECT DISTINCT DATE_FORMAT(`date`, '%Y-%m-%d') AS date FROM `transactions` ORDER BY date",
      );
      const out = dates.map((row) => row.date).filter((date) => !fits(date));
      const rows: { id: string }[] = await queryRunner.query(
        "SELECT `id` FROM `transactions` WHERE DATE_FORMAT(`date`, '%Y-%m-%d') IN (?) ORDER BY `id`",
        [out],
      );

      throw new Error(
        `Cannot revert; nothing was changed. These transactions are dated outside what a TIMESTAMP holds: ` +
          `${listed(rows.map((row) => row.id))}.`,
      );
    }
  }

  private async restoreTimestamps(queryRunner: QueryRunner): Promise<void> {
    const dates: { date: string }[] = await queryRunner.query(
      "SELECT DISTINCT DATE_FORMAT(`date`, '%Y-%m-%d') AS date FROM `transactions` ORDER BY date",
    );

    for (const { date } of dates) {
      await queryRunner.query(
        `UPDATE \`transactions\` t
         INNER JOIN (
           SELECT \`id\`, ROW_NUMBER() OVER (ORDER BY \`order_key\`) - 1 AS position
           FROM \`transactions\` WHERE \`date\` = ?
         ) d ON d.\`id\` = t.\`id\`
         SET t.\`timestamp\` = TIMESTAMPADD(MICROSECOND, d.position * 1000, ?)`,
        [date, new Date(legacyDayStart(date))],
      );
    }
  }

  // Only the field at `from` of a stored transaction result changes; other
  // operations, keys, fingerprints and expiry stay as they are.
  private async convertStoredResults(
    queryRunner: QueryRunner,
    from: string,
    convert: (value: string, id: string) => { path: string; value: string },
  ): Promise<void> {
    const rows: { id: string; value: string }[] = await queryRunner.query(
      `SELECT \`id\`, JSON_UNQUOTE(JSON_EXTRACT(\`response_body\`, ?)) AS value FROM \`idempotency_keys\`
       WHERE ${TRANSACTION_RESULTS} AND JSON_CONTAINS_PATH(\`response_body\`, 'one', ?) ORDER BY \`id\``,
      [from, from],
    );

    for (const row of rows) {
      const { path, value } = convert(row.value, String(row.id));
      await queryRunner.query(
        'UPDATE `idempotency_keys` SET `response_body` = JSON_REMOVE(JSON_SET(`response_body`, ?, ?), ?) WHERE `id` = ?',
        [path, value, from, row.id],
      );
    }
  }

  private async columns(queryRunner: QueryRunner): Promise<Map<string, ColumnState>> {
    const rows: { COLUMN_NAME: string; IS_NULLABLE: string; EXTRA: string }[] = await queryRunner.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
         AND COLUMN_NAME IN ('timestamp', 'date', 'order_key')`,
    );

    return new Map(
      rows.map((row) => [
        row.COLUMN_NAME,
        { nullable: row.IS_NULLABLE === 'YES', autoIncrement: /auto_increment/i.test(row.EXTRA) },
      ]),
    );
  }

  private async hasIndex(queryRunner: QueryRunner, index: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND INDEX_NAME = ?`,
      [index],
    );

    return rows.length > 0;
  }
}
