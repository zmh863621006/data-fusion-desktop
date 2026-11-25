import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, inside, parseArguments, checkedTarget, checkedVersion, ordinary, readJson } from './business-package-common.mjs';
import { stageKirin990Compatibility } from './stage-kirin990-compat.mjs';

export async function stageBusinessShellDeb(options = {}) {
  const root = resolve(options.projectRoot ?? PROJECT), receiptPath = resolve(root, options.shellStage ?? '');
  assert(inside(receiptPath, join(root, '.tmp/business-shell')), 'Use a generated shell stage receipt');
  const shell = await readJson(receiptPath), target = checkedTarget(shell.target), version = checkedVersion(shell.shellVersion);
  assert(shell.deployment === undefined || shell.deployment === 'huizhou-intranet', 'Invalid DEB deployment identity');
  const huizhou = shell.deployment === 'huizhou-intranet', applicationDirectory = huizhou ? 'huizhou-data-fusion' : 'data-fusion';
  const productName = huizhou ? '惠州数据融合助手' : '数据融合助手';
  assert(target.platform === 'linux' && shell.stage === dirname(receiptPath), 'DEB requires a Linux shell stage');
  const source = resolve(shell.outputDirectory, target.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked');
  assert(inside(source, root), 'Packaged shell escaped the project'); await ordinary(source, true);
  await ordinary(join(source, 'data-fusion')); await ordinary(join(source, 'resources/app.asar'));
  const stagingRoot = join(root, '.tmp/kylin-deb'); await mkdir(stagingRoot, { recursive: true }); await ordinary(stagingRoot, true);
  const staging = await mkdtemp(join(stagingRoot, `${version}-${target.arch}-${target.variant}-shell-`));
  await mkdir(join(staging, 'DEBIAN')); await cp(source, join(staging, 'opt', applicationDirectory), { recursive: true });
  await mkdir(join(staging, 'usr/share/applications'), { recursive: true });
  await mkdir(join(staging, 'usr/share/icons/hicolor/512x512/apps'), { recursive: true });
  await cp(join(root, 'resources/app-icon.png'), join(staging, 'usr/share/icons/hicolor/512x512/apps', applicationDirectory + '.png'));
  await writeFile(join(staging, 'usr/share/applications', huizhou ? 'cn.zzkj.datafusion.huizhou.desktop' : 'cn.zzkj.datafusion.desktop'), [
    '[Desktop Entry]', 'Type=Application', `Name=${productName}`, 'Comment=数据回流与双公示工具',
    `Exec=/opt/${applicationDirectory}/data-fusion %U`, `Icon=${applicationDirectory}`, 'Terminal=false', 'Categories=Office;',
    `StartupWMClass=${huizhou ? 'huizhou-data-fusion-desktop' : 'data-fusion'}`, '',
  ].join('\n'));
  const require = createRequire(import.meta.url), linux = require(join(root, 'electron-builder.linux.cjs'));
  await writeFile(join(staging, 'DEBIAN/control'), [
    `Package: ${huizhou ? 'huizhou-data-fusion-desktop' : 'data-fusion-desktop'}`, `Version: ${version}`, 'Section: utils', 'Priority: optional',
    `Architecture: ${target.arch === 'x64' ? 'amd64' : 'arm64'}`, 'Maintainer: 数据融合助手 <support@datafusion.local>',
    `Depends: ${linux.deb.depends.join(', ')}`, `Description: ${productName}麒麟版`,
    huizhou ? ' 独立惠州安装及资料目录；不迁移或清除深圳客户端资料。' : ' 固定启动器与业务更新包。授权、会话、业务数据和导出文件保留在现有用户目录。', '',
  ].join('\n'));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert(!result.error && result.status === 0, result.error?.message ?? result.stderr ?? `${command} failed`);
    return result.stdout.trim();
  };
  if (target.variant === 'kirin990') await stageKirin990Compatibility(staging,
    join(root, 'resources/kirin990-compat/arm64'), join(root, 'resources/kirin990-compat/sources.json'), { deployment: shell.deployment });
  const file = join(shell.outputDirectory, `${productName}-麒麟${target.variant === 'kirin990' ? '海思990' : ''}版-${version}-${target.arch}.deb`);
  const python = options.python ?? 'python';
  // The original CLI deliberately reads the root package version. Invoke its
  // reviewed build function so a fixed-shell candidate can use its own version
  // and output directory without mutating package.json or the legacy release.
  const bridge = [
    'import importlib.util,json,pathlib,sys',
    'spec=importlib.util.spec_from_file_location("kylin_deb_builder",sys.argv[1])',
    'builder=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(builder)',
    'result=builder.build(pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4],pathlib.Path(sys.argv[5]),sys.argv[6] or None,sys.argv[7] or None)',
    'print(json.dumps(result,ensure_ascii=False))',
  ].join(';');
  const built = JSON.parse(run(python, ['-c', bridge, join(root, 'scripts/build-kylin-deb.py'), staging,
    target.arch, version, file, target.variant === 'kirin990' ? 'kirin990' : '', shell.deployment ?? '']));
  const verified = JSON.parse(run(python, [join(root, 'scripts/verify-kylin-deb.py'), '--package', file, '--stage', staging,
    '--arch', target.arch, '--version', version, ...(target.variant === 'kirin990' ? ['--compatibility', 'kirin990'] : []),
    ...(huizhou ? ['--deployment', 'huizhou-intranet'] : [])]));
  const receipt = { schema: 1, file, staging, target, shellStage: receiptPath, built, verified, targetExecuted: false };
  await writeFile(join(shell.outputDirectory, 'shell-deb.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), ['shell-stage', 'python']); assert(args['shell-stage'], 'Provide --shell-stage <stage.json>');
  console.log(JSON.stringify(await stageBusinessShellDeb({ shellStage: args['shell-stage'], python: args.python })));
}
