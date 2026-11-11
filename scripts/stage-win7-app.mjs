import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const source = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve('.tmp/win7-app');
await mkdir(directory, { recursive: true });
assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase(), 'Generated staging path must not redirect outside the workspace');
const generatedOutput = resolve(directory, 'out');
assert.equal(dirname(generatedOutput), directory);
const previous = await lstat(generatedOutput).catch(() => null);
if (previous) {
  assert(previous.isDirectory() && !previous.isSymbolicLink(), 'Unexpected generated build output');
  await rm(generatedOutput, { recursive: true });
}
await cp('out-win7', `${directory}/out`, { recursive: true });
await writeFile(`${directory}/package.json`, JSON.stringify({ name: source.name, productName: source.productName,
  version: source.version, main: 'out/main/index.js', author: source.author, description: source.description,
  license: source.license, private: true }, null, 2));
console.log('Win7 runtime application staged without changing the modern runtime');
