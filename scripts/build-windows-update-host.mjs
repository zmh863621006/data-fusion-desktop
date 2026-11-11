import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const legacy = process.argv.includes('--legacy');
assert(/^\d+\.\d+\.\d+$/.test(version));
const source = await readFile('resources/windows-update-host.cs', 'utf8');
assert(!/powershell|encodedcommand|cmd\.exe|wscript|cscript/i.test(source), 'Update host must use native process APIs only');
await mkdir('.tmp', { recursive: true });
const metadata = resolve(legacy ? '.tmp/windows-update-host-legacy-metadata.cs' : '.tmp/windows-update-host-metadata.cs');
const output = resolve(legacy ? 'resources/win7-compat/DataFusion.UpdateHost.exe' : 'resources/DataFusion.UpdateHost.exe');
if (legacy) await mkdir(resolve('resources/win7-compat'), { recursive: true });
await writeFile(metadata, `using System.Reflection;\n[assembly: AssemblyTitle("Data Fusion Update Host")]\n[assembly: AssemblyDescription("Data Fusion verified Windows installer handoff")]\n[assembly: AssemblyProduct("Data Fusion Assistant")]\n[assembly: AssemblyCompany("Data Fusion Assistant")]\n[assembly: AssemblyVersion("${version}.0")]\n[assembly: AssemblyFileVersion("${version}.0")]\n`);
const compiler = join(process.env.SystemRoot, legacy ? 'Microsoft.NET/Framework64/v3.5/csc.exe' : 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const webExtensions = legacy
  ? join(process.env.SystemRoot, 'assembly/GAC_MSIL/System.Web.Extensions/3.5.0.0__31bf3856ad364e35/System.Web.Extensions.dll')
  : 'System.Web.Extensions.dll';
execFileSync(compiler,
  [...(legacy ? ['/noconfig', '/reference:System.dll'] : []), '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/win32icon:' + resolve('resources/app-icon.ico'),
    '/reference:' + webExtensions, '/out:' + output, resolve('resources/windows-update-host.cs'), metadata],
  { windowsHide: true, encoding: 'utf8' });
if (legacy) {
  assert((await readFile(output)).includes(Buffer.from('v2.0.50727')), 'Win7 update host must target the built-in CLR2 runtime');
  await writeFile(output + '.config', '<?xml version="1.0" encoding="utf-8"?>\n<configuration><startup><supportedRuntime version="v2.0.50727"/><supportedRuntime version="v4.0"/></startup></configuration>\n');
}
console.log(JSON.stringify({ status: 'built', nativeUpdateHost: true, powershellRequired: false, version, runtime: legacy ? 'CLR2-.NET3.5' : 'CLR4',
  hostSha256: createHash('sha256').update(await readFile(output)).digest('hex') }));
