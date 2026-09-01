import { randomInt } from 'node:crypto';

export const CONFIRMATION_CODE_LENGTH = 6;

export const generateRandomNumberString = () => {
  const max = 10 ** CONFIRMATION_CODE_LENGTH;
  const randomNumber = randomInt(0, max);
  return String(randomNumber).padStart(CONFIRMATION_CODE_LENGTH, '0');
};
