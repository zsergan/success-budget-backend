import { BadRequestException } from '@nestjs/common';

import { ParseOptionalTimeZonePipe } from './parse-optional-time-zone.pipe';

describe('ParseOptionalTimeZonePipe', () => {
  const pipe = new ParseOptionalTimeZonePipe();
  const metadata = { type: 'query' as const, data: 'time_zone' };

  it('passes an absent value through', () => {
    expect(pipe.transform(undefined, metadata)).toBeUndefined();
  });

  it('returns the canonical IANA name', () => {
    expect(pipe.transform('Europe/Moscow', metadata)).toBe('Europe/Moscow');
    expect(pipe.transform('UTC', metadata)).toBe('UTC');
  });

  it.each(['+03:00', 'Mars/Olympus', '', 3])('rejects %p', (value) => {
    expect(() => pipe.transform(value, metadata)).toThrow(BadRequestException);
  });
});
