import { PartialType } from '@nestjs/swagger';

import { CreateLimitDto } from './create-limit.dto';

export class UpdateLimitDto extends PartialType(CreateLimitDto) {}
