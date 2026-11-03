import {
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
  registerDecorator,
  type ValidationArguments,
} from 'class-validator';

function IsNotSentWith(other: string): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isNotSentWith',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [other],
      options: { message: `${String(propertyName)} must not be sent together with ${other}` },
      validator: {
        validate: (_value: unknown, args: ValidationArguments) =>
          (args.object as Record<string, unknown>)[other] === undefined,
      },
    });
}

// Exactly one of the two: the manual six-digit code or the link token.
export class AcceptSpaceInviteDto {
  /** The six-digit code from the invitation email. */
  @ValidateIf((dto: AcceptSpaceInviteDto) => dto.token === undefined)
  @IsNotEmpty()
  @IsString()
  @MaxLength(6)
  code?: string;

  /** The token from the invitation link (`/invite#token=...`). */
  @ValidateIf((dto: AcceptSpaceInviteDto) => dto.token !== undefined)
  @IsNotSentWith('code')
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  token?: string;
}
