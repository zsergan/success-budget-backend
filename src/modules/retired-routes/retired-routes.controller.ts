import { All, Controller, HttpStatus } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { ApiException } from '@shared/api.exception';

// The v1 transaction, statistics and wallet routes, removed with wallets
// (docs/transactions-v2-contract.md#release-b): app builds that still call
// them get a code they can tell from a mistyped route.
@ApiExcludeController()
@Controller('spaces/:spaceId')
export class RetiredRoutesController {
  @All(['transactions', 'transactions/*path', 'statistics/*path', 'wallets', 'wallets/*path'])
  retired(): never {
    throw new ApiException('LEGACY_API_RETIRED', HttpStatus.GONE);
  }
}
