import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DataSource } from 'typeorm';

import { REQUIRED_MIGRATION, SchemaCheck, readSchemaState, schemaProblem } from './schema-check';

const migration = (name: string) => ({ name });

function dataSourceWith(built: string[], executed: string[] | null) {
  const queryRunner = {
    hasTable: jest.fn().mockResolvedValue(executed !== null),
    query: jest.fn().mockResolvedValue((executed ?? []).map((name) => ({ name }))),
    release: jest.fn(),
  };
  const dataSource = {
    migrations: built.map(migration),
    options: {},
    createQueryRunner: () => queryRunner,
  } as unknown as DataSource;

  return { dataSource, queryRunner };
}

describe('schema check', () => {
  it('requires the newest migration in src/migrations', () => {
    const dir = join(__dirname, '../migrations');
    const newest = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .sort()
      .pop()!;

    expect(readFileSync(join(dir, newest), 'utf8')).toContain(`export class ${REQUIRED_MIGRATION} `);
  });

  describe('readSchemaState', () => {
    it('lists the pending migrations of the build and the unknown ones of the database', async () => {
      const { dataSource, queryRunner } = dataSourceWith(['A1', 'B2', REQUIRED_MIGRATION], ['A1', 'Z9']);

      await expect(readSchemaState(dataSource)).resolves.toEqual({
        pending: ['B2', REQUIRED_MIGRATION],
        unknown: ['Z9'],
        requiredMissing: false,
      });
      expect(queryRunner.hasTable).toHaveBeenCalledWith('migrations');
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('treats a database without the migrations table as having run none', async () => {
      const { dataSource, queryRunner } = dataSourceWith(['A1', REQUIRED_MIGRATION], null);

      await expect(readSchemaState(dataSource)).resolves.toMatchObject({ pending: ['A1', REQUIRED_MIGRATION] });
      expect(queryRunner.query).not.toHaveBeenCalled();
    });

    it('notices a build without the required migration', async () => {
      const { dataSource } = dataSourceWith(['A1'], ['A1']);

      await expect(readSchemaState(dataSource)).resolves.toMatchObject({ requiredMissing: true });
    });
  });

  describe('schemaProblem', () => {
    it('accepts an up-to-date schema, also one ahead of the build', () => {
      expect(schemaProblem({ pending: [], unknown: ['Z9'], requiredMissing: false })).toBeNull();
    });

    it('refuses pending migrations, naming them', () => {
      expect(schemaProblem({ pending: ['B2'], unknown: [], requiredMissing: false })).toContain('Pending: B2');
    });

    it('refuses a build without the required migration', () => {
      expect(schemaProblem({ pending: [], unknown: [], requiredMissing: true })).toContain(REQUIRED_MIGRATION);
    });
  });

  describe('SchemaCheck', () => {
    it('fails the app start on pending migrations', async () => {
      const { dataSource } = dataSourceWith(['A1', REQUIRED_MIGRATION], ['A1']);

      await expect(new SchemaCheck(dataSource).onApplicationBootstrap()).rejects.toThrow(REQUIRED_MIGRATION);
    });

    it('lets the app start on an up-to-date schema', async () => {
      const { dataSource } = dataSourceWith([REQUIRED_MIGRATION], [REQUIRED_MIGRATION, 'Z9']);

      await expect(new SchemaCheck(dataSource).onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});
