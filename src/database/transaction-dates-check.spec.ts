import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('@config/typeorm-cli.data-source', () => ({
  __esModule: true,
  default: { initialize: jest.fn(), destroy: jest.fn() },
}));
jest.mock('./transaction-dates', () => ({
  readDateSchema: jest.fn(),
  readDateLedger: jest.fn(),
  compareDateLedgers: jest.fn(),
}));

const LEDGER = { read_from: 'timestamp', transactions: 5, spaces: [{}, {}], days: [{}, {}, {}], months: [{}] };

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Runs the CLI as `transaction-dates-check ...args` against fresh mocks.
const runCli = async (args: string[], setup: (mocks: Mocks) => void = () => undefined) => {
  jest.resetModules();
  process.argv = ['node', 'transaction-dates-check', ...args];
  const mocks: Mocks = {
    dates: jest.requireMock('./transaction-dates'),
    dataSource: jest.requireMock('@config/typeorm-cli.data-source').default,
  };
  mocks.dataSource.initialize.mockResolvedValue(undefined);
  mocks.dataSource.destroy.mockResolvedValue(undefined);
  mocks.dates.readDateSchema.mockResolvedValue({ hasTimestamp: true, hasDate: false });
  mocks.dates.readDateLedger.mockResolvedValue(LEDGER);
  mocks.dates.compareDateLedgers.mockReturnValue([]);
  setup(mocks);

  await import('./transaction-dates-check');
  await settle();

  return mocks;
};

interface Mocks {
  dates: { [name in 'readDateSchema' | 'readDateLedger' | 'compareDateLedgers']: jest.Mock };
  dataSource: { initialize: jest.Mock; destroy: jest.Mock };
}

describe('transaction-dates-check', () => {
  const argv = process.argv;
  let dir: string;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dates-check-'));
    log = jest.spyOn(console, 'log').mockImplementation();
    error = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it.each([[[]], [['snapshot']], [['restore', 'ledger.json']]])('prints the usage for %p', async (args) => {
    const { dataSource } = await runCli(args);

    expect(error).toHaveBeenCalledWith('Usage: transaction-dates-check (snapshot <file> | verify <file>)');
    expect(process.exitCode).toBe(1);
    expect(dataSource.destroy).toHaveBeenCalled();
  });

  it('writes a snapshot to a file', async () => {
    const file = join(dir, 'before.json');
    await runCli(['snapshot', file]);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(LEDGER);
    expect(error).toHaveBeenCalledWith(`Snapshot of 5 transactions in 2 spaces, 3 space days, written to ${file}.`);
    expect(process.exitCode).toBeUndefined();
  });

  it('writes a snapshot to stdout for "-"', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runCli(['snapshot', '-']);

    expect(JSON.parse(write.mock.calls[0][0] as string)).toEqual(LEDGER);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a snapshot once the migration ran', async () => {
    const file = join(dir, 'before.json');
    const { dates } = await runCli(['snapshot', file], ({ dates }) =>
      dates.readDateSchema.mockResolvedValue({ hasTimestamp: false, hasDate: true }),
    );

    expect(dates.readDateLedger).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the migration already ran'));
    expect(process.exitCode).toBe(1);
  });

  it('verifies the database against a snapshot', async () => {
    const file = join(dir, 'before.json');
    writeFileSync(file, JSON.stringify(LEDGER));
    const { dates } = await runCli(['verify', file]);

    expect(dates.compareDateLedgers).toHaveBeenCalledWith(LEDGER, LEDGER);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Reconciliation OK: 5 transactions in 2 spaces/));
    expect(process.exitCode).toBeUndefined();
  });

  it('fails verification on a difference, listing each', async () => {
    const file = join(dir, 'before.json');
    writeFileSync(file, JSON.stringify(LEDGER));
    await runCli(['verify', file], ({ dates }) =>
      dates.compareDateLedgers.mockReturnValue(['operations: 4 before, 3 after', 'space 2: ... before, missing after']),
    );

    expect(error.mock.calls.map(([line]) => line)).toEqual([
      'Reconciliation found 2 differences:',
      '- operations: 4 before, 3 after',
      '- space 2: ... before, missing after',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['an error', new Error('connect ECONNREFUSED'), 'connect ECONNREFUSED'],
    ['another value', 'no database', 'no database'],
  ])('exits 1 when the database cannot be reached, printing %s', async (_case, failure, printed) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { dates } = await runCli(['verify', join(dir, 'before.json')], ({ dataSource }) =>
      dataSource.initialize.mockRejectedValue(failure),
    );

    expect(dates.readDateLedger).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(printed);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
