import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: boolean;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  $ref?: string;
};

const MONEY_PATTERN = '^-?\\d+\\.\\d{2}$';
const NULL_ONLY: Schema = { type: 'object', nullable: true, enum: [null] };

describe('Statistics OpenAPI', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  let schemas: Record<string, Schema>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StatisticsController],
      providers: [{ provide: StatisticsService, useValue: {} }],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    schemas = document.components!.schemas as Record<string, Schema>;
  });

  afterAll(async () => {
    await app.close();
  });

  const refName = (schema: Schema): string | undefined =>
    (schema.$ref ?? schema.allOf?.[0]?.$ref ?? schema.anyOf?.[0]?.$ref)?.split('/').pop();

  const collectRefs = (value: unknown): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) =>
          key === '$ref' && typeof child === 'string' ? [child] : collectRefs(child),
        )
      : [];

  // every schema reachable from the name, the name included
  const reachable = (name: string, seen = new Set<string>()): Set<string> => {
    seen.add(name);

    for (const ref of collectRefs(schemas[name])) {
      const next = ref.split('/').pop()!;

      if (!seen.has(next)) {
        reachable(next, seen);
      }
    }

    return seen;
  };

  const properties = (name: string) => Object.entries(schemas[name].properties ?? {});

  const nullableFields = (name: string) =>
    properties(name)
      .filter(([, property]) => property.nullable || property.anyOf?.some((branch) => branch.nullable))
      .map(([field]) => field);

  it.each([
    ['summary', 'StatisticsSummary'],
    ['trend', 'StatisticsTrend'],
    ['breakdown', 'StatisticsBreakdown'],
  ])('describes the body of a successful %s', (block, schema) => {
    const response = document.paths[`/spaces/{spaceId}/statistics/${block}`].get!.responses['200'] as {
      content: Record<string, { schema: Schema }>;
    };

    expect(refName(response.content['application/json'].schema)).toBe(schema);
    expect(schemas[schema].properties).toBeDefined();
  });

  it('defines every referenced schema and marks every object field as required', () => {
    const names = ['StatisticsSummary', 'StatisticsTrend', 'StatisticsBreakdown'].flatMap((name) => [
      ...reachable(name),
    ]);

    for (const name of new Set(names)) {
      expect({ name, defined: name in schemas }).toEqual({ name, defined: true });

      if (schemas[name].type === 'object') {
        expect({ name, required: [...(schemas[name].required ?? [])].sort() }).toEqual({
          name,
          required: Object.keys(schemas[name].properties ?? {}).sort(),
        });
      }
    }
  });

  it('marks exactly the nullable fields', () => {
    expect(nullableFields('StatisticsPeriod')).toEqual(['actual_to']);
    expect(nullableFields('Change')).toEqual(['percent']);
    expect(nullableFields('StatisticsSummary')).toEqual(['previous', 'change', 'last_transaction_date']);
    expect(nullableFields('PreviousPeriod')).toEqual([]);
    expect(nullableFields('TrendBucket')).toEqual(['income', 'expense']);
    expect(nullableFields('CategoryItem')).toEqual([]);
    expect(nullableFields('WalletItem')).toEqual(['icon']);
    expect(nullableFields('CategoryOtherItem')).toEqual(['id', 'name', 'icon', 'color']);
    expect(nullableFields('DeletedWalletsItem')).toEqual(['id', 'name', 'icon', 'color']);
    expect(nullableFields('CategoryBreakdown')).toEqual(['other']);
    expect(nullableFields('WalletBreakdown')).toEqual(['deleted_wallets', 'other']);
  });

  it('describes a nullable object as its schema or null, in OpenAPI 3.0 terms', () => {
    const nullableObjects: [string, string, string][] = [
      ['StatisticsSummary', 'previous', 'PreviousPeriod'],
      ['StatisticsSummary', 'change', 'Changes'],
      ['CategoryBreakdown', 'other', 'CategoryOtherItem'],
      ['WalletBreakdown', 'deleted_wallets', 'DeletedWalletsItem'],
      ['WalletBreakdown', 'other', 'WalletOtherItem'],
    ];

    for (const [schema, field, target] of nullableObjects) {
      const { anyOf, ...rest } = schemas[schema].properties![field];

      expect({ schema, field, anyOf, rest: Object.keys(rest).filter((key) => key !== 'description') }).toEqual({
        schema,
        field,
        anyOf: [{ $ref: `#/components/schemas/${target}` }, NULL_ONLY],
        rest: [],
      });
      expect(schemas[schema].required).toContain(field);
    }

    expect(refName(schemas.CategoryOtherItem.properties!.children.items!)).toBe('CategoryItem');
    expect(refName(schemas.WalletOtherItem.properties!.children.items!)).toBe('WalletItem');
  });

  it('describes money as decimal strings', () => {
    const money: [string, string][] = [
      ['MoneyCount', 'amount'],
      ['Change', 'delta'],
      ['StatisticsSummary', 'net'],
      ['PreviousPeriod', 'net'],
      ['TrendBucket', 'income'],
      ['TrendBucket', 'expense'],
      ['CategoryItem', 'amount'],
      ['WalletItem', 'amount'],
      ['DeletedWalletsItem', 'amount'],
      ['CategoryOtherItem', 'amount'],
      ['CategoryBreakdown', 'total_amount'],
      ['WalletBreakdown', 'total_amount'],
    ];

    for (const [schema, field] of money) {
      const property = schemas[schema].properties![field];

      expect({ schema, field, type: property.type, pattern: property.pattern }).toEqual({
        schema,
        field,
        type: 'string',
        pattern: MONEY_PATTERN,
      });
    }

    expect(new RegExp(MONEY_PATTERN).test('-510.50')).toBe(true);
    expect(new RegExp(MONEY_PATTERN).test('300000000.27')).toBe(true);
    expect(new RegExp(MONEY_PATTERN).test('810.5')).toBe(false);
  });

  it('takes transaction_type on breakdown only and echoes it', () => {
    const queryNames = (block: string) =>
      (document.paths[`/spaces/{spaceId}/statistics/${block}`].get!.parameters as { name: string; in: string }[])
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name);

    expect(queryNames('summary')).not.toContain('transaction_type');
    expect(queryNames('trend')).not.toContain('transaction_type');
    expect(queryNames('breakdown')).toContain('transaction_type');
    expect(refName(schemas.StatisticsBreakdown.properties!.transaction_type)).toBe('TransactionType');
    expect(schemas.TransactionType.enum).toEqual(['income', 'expense']);
  });

  it('lists the enums', () => {
    expect(schemas.StatisticsPeriodType.enum).toEqual(['week', 'month', 'year', 'custom']);
    expect(schemas.StatisticsTimeState.enum).toEqual(['past', 'current', 'future']);
    expect(schemas.StatisticsTrendGranularity.enum).toEqual(['day', 'week', 'month']);
    expect(refName(schemas.CategoryItem.properties!.icon)).toBe('CategoryIcon');
    expect(refName(schemas.CategoryItem.properties!.color)).toBe('AppColor');

    expect(
      ['CategoryItem', 'WalletItem', 'DeletedWalletsItem', 'CategoryOtherItem', 'WalletOtherItem'].map(
        (name) => schemas[name].properties!.kind.enum,
      ),
    ).toEqual([['category'], ['wallet'], ['deleted_wallets'], ['other'], ['other']]);
  });
});
