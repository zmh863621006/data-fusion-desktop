import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('../resources/', import.meta.url);
const source = await readFile(new URL('app-icon.svg', root), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const render = size => new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
const images = sizes.map(render);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (let index = 0; index < sizes.length; index++) {
  const size = sizes[index], entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(new URL('app-icon.ico', root), Buffer.concat([directory, ...images]));
await writeFile(new URL('app-icon.png', root), render(512));
const icon = await readFile(new URL('app-icon.ico', root));
assert.equal(icon.readUInt16LE(2), 1);
assert.equal(icon.readUInt16LE(4), 7);
console.log(`Application icons generated: ${fileURLToPath(root)} (SVG, 512px PNG, 7-size Windows ICO)`);
