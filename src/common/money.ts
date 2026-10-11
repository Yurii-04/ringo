export const uah = (kopecks: number): string => {
  const value = kopecks / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} грн`;
};
