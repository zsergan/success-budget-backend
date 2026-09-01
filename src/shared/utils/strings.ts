import { randomInt, timingSafeEqual } from 'node:crypto';

export const CONFIRMATION_CODE_LENGTH = 6;

export const generateRandomNumberString = () => {
  const max = 10 ** CONFIRMATION_CODE_LENGTH;
  const randomNumber = randomInt(0, max);
  return String(randomNumber).padStart(CONFIRMATION_CODE_LENGTH, '0');
};

export const constantTimeEquals = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
};
