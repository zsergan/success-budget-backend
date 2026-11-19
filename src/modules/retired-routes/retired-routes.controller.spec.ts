import { RetiredRoutesController } from './retired-routes.controller';
import { ErrorMessages } from '@shared/error-messages';

describe('RetiredRoutesController', () => {
  it('answers 410 LEGACY_API_RETIRED', () => {
    expect(() => new RetiredRoutesController().retired()).toThrow(
      expect.objectContaining({
        code: 'LEGACY_API_RETIRED',
        status: 410,
        message: ErrorMessages.LEGACY_API_RETIRED,
      }),
    );
  });
});
