import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import linux from '../electron-builder.linux.cjs';

// Also supports a Windows build host: create the deb tree here, then use the
// target's dpkg-deb --root-owner-group to assemble the installable artifact.
const architecture = process.argv[2];
assert(['x64', 'arm64'].includes(architecture), 'Usage: node scripts/stage-kylin-deb.mjs <x64|arm64>');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const debArchitecture = architecture === 'x64' ? 'amd64' : 'arm64';
const source = resolve('release', version, 'kylin', architecture === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked');
const staging = resolve('.tmp', 'kylin-deb', `${version}-${debArchitecture}-${Date.now()}`);
await mkdir(join(staging, 'DEBIAN'), { recursive: true });
await cp(source, join(staging, 'opt', 'data-fusion'), { recursive: true });
await mkdir(join(staging, 'usr/share/applications'), { recursive: true });
await mkdir(join(staging, 'usr/share/icons/hicolor/512x512/apps'), { recursive: true });
await cp('resources/app-icon.png', join(staging, 'usr/share/icons/hicolor/512x512/apps/data-fusion.png'));
await writeFile(join(staging, 'usr/share/applications/cn.zzkj.datafusion.desktop'), [
  '[Desktop Entry]', 'Type=Application', 'Name=数据融合助手', 'Comment=数据回流与双公示工具',
  'Exec=/opt/data-fusion/data-fusion %U', 'Icon=data-fusion', 'Terminal=false',
  'Categories=Office;', 'StartupWMClass=data-fusion', '',
].join('\n'));
await writeFile(join(staging, 'DEBIAN/control'), [
  'Package: data-fusion-desktop', `Version: ${version}`, 'Section: utils', 'Priority: optional',
  `Architecture: ${debArchitecture}`, 'Maintainer: 数据融合助手 <support@datafusion.local>',
  `Depends: ${linux.deb.depends.join(', ')}`, 'Description: 数据融合助手麒麟版',
  ' 支持业务数据回流、双公示导出及本地统计展示。用户数据与安装目录分开保存。', '',
].join('\n'));
console.log(JSON.stringify({ staging, architecture: debArchitecture, version,
  artifactName: `数据融合助手-麒麟版-${version}-${architecture}.deb` }));
