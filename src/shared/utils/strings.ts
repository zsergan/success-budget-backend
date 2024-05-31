export const generateRandomNumberString = () => {
  const randomNumber = Math.floor(Math.random() * 10000);
  return String(randomNumber).padStart(4, '0');
};
