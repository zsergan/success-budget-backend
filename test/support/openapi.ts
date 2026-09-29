import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: boolean;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  items?: Schema;
  allOf?: Schema[];
  $ref?: string;
}

const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
};

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, new DocumentBuilder().build());
}

export function okResponseSchema(document: OpenAPIObject, pathSuffix: string): Schema {
  const path = Object.keys(document.paths).find((candidate) => candidate.endsWith(pathSuffix));
  const response = document.paths[path!].get!.responses['200'] as { content: Record<string, { schema: Schema }> };

  return response.content['application/json'].schema;
}

// A small validator for the subset of OpenAPI 3.0 the Nest generator emits.
// Unlike the default, an object may not carry properties its schema lacks.
export function schemaErrors(document: OpenAPIObject, schema: Schema, value: unknown, at = '$'): string[] {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop()!;

    return schemaErrors(document, document.components!.schemas![name] as Schema, value, at);
  }

  if (value === null) {
    return schema.nullable ? [] : [`${at}: null is not allowed`];
  }

  if (schema.allOf) {
    return schema.allOf.flatMap((part) => schemaErrors(document, part, value, at));
  }

  if (schema.enum && !schema.enum.includes(value)) {
    return [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return [`${at}: not an object`];
      }

      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};

      return [
        ...(schema.required ?? []).filter((key) => !(key in record)).map((key) => `${at}.${key}: missing`),
        ...Object.keys(record)
          .filter((key) => !(key in properties))
          .map((key) => `${at}.${key}: not in the schema`),
        ...Object.entries(properties)
          .filter(([key]) => key in record)
          .flatMap(([key, property]) => schemaErrors(document, property, record[key], `${at}.${key}`)),
      ];
    }
    case 'array':
      return Array.isArray(value)
        ? value.flatMap((item, i) => schemaErrors(document, schema.items!, item, `${at}[${i}]`))
        : [`${at}: not an array`];
    case 'string':
      if (typeof value !== 'string') {
        return [`${at}: not a string`];
      }

      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        return [`${at}: ${value} does not match ${schema.pattern}`];
      }

      return schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)
        ? [`${at}: ${value} is not a ${schema.format}`]
        : [];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at}: not an integer`];
    case 'number':
      return typeof value === 'number' ? [] : [`${at}: not a number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: not a boolean`];
    default:
      return [];
  }
}
