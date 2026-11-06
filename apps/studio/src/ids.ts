import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(prefix: string): string {
  let time = "";
  let n = Date.now();
  for (let i = 0; i < 10; i += 1) {
    time = ENCODING[n % 32] + time;
    n = Math.floor(n / 32);
  }
  const bytes = randomBytes(10);
  let buffer = 0;
  let bits = 0;
  let random = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ENCODING[(buffer >> bits) & 31];
    }
  }
  return `${prefix}${time}${random.slice(0, 16)}`;
}
