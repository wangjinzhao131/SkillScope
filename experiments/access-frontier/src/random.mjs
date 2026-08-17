import { createHash } from "node:crypto";

function seedWords(seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  return [0, 4, 8, 12].map((offset) => digest.readUInt32LE(offset));
}
export function createPrng(seed) {
  let [a, b, c, d] = seedWords(seed);
  return function random() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const result = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11));
    c = (c + result) | 0;
    return (result >>> 0) / 4294967296;
  };
}

export function shuffle(values, seed) {
  const result = [...values];
  const random = createPrng(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
