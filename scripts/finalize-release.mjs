import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const directory = resolve('release', version);
const names = [`数据融合助手-安装包-${version}-x64.exe`, `数据融合助手-免安装版-${version}-x64.zip`, '使用说明.txt'];
const artifacts = [];
for (const name of names) {
  const path = join(directory, name), info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Release artifact is missing/empty: ${name}`);
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  artifacts.push({ name, bytes: info.size, sha256: hash.digest('hex') });
}
await writeFile(join(directory, 'SHA256SUMS.txt'), artifacts.map(file => `${file.sha256}  ${file.name}`).join('\r\n') + '\r\n');
await writeFile(join(directory, 'release-manifest.json'), JSON.stringify({ productName: '数据融合助手', version,
  platform: 'win32', arch: 'x64', authenticode: 'unsigned-user-confirmed',
  firstRunRequiresActivation: true, containsUserData: false, artifacts }, null, 2));
console.log(JSON.stringify({ directory, artifacts }, null, 2));
