import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// Raster PNG: the answer is never embedded as SVG text, metadata, or an API field.
const glyphs = {
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
};
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, bytes])));
  return Buffer.concat([length, tag, bytes, checksum]);
}
export function createCaptcha() {
  const alphabet = Object.keys(glyphs);
  const answer = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const width = 180, height = 56, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 246);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  const dot = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    for (let c = 0; c < 3; c++) pixels[y * stride + 1 + x * 3 + c] = color[c];
  };
  for (let i = 0; i < 180; i++) dot(randomInt(width), randomInt(height), [170,195,219]);
  [...answer].forEach((letter, index) => {
    const left = 10 + index * 33 + randomInt(4), top = 9 + randomInt(9), skew = (randomInt(7) - 3) / 10;
    const color = [randomInt(25,85), randomInt(55,115), randomInt(90,155)];
    glyphs[letter].forEach((row, y) => [...row].forEach((value, x) => {
      if (value === '1') for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) dot(left + x * 4 + sx + skew * (y * 4 + sy), top + y * 4 + sy, color);
    }));
  });
  for (let line = 0; line < 2; line++) {
    const start = randomInt(8,48), phase = randomInt(10);
    for (let x = 0; x < width; x++) dot(x, start + 4 * Math.sin(x / 17 + phase), [135,165,195]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  return { answer, image: `data:image/png;base64,${png.toString('base64')}` };
}
