import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const source = resolve('resources/export-preserver.cs');
const legacy = process.argv.includes('--legacy');
const output = resolve(legacy ? 'resources/win7-compat/DataFusion.ExportPreserver.exe' : 'resources/DataFusion.ExportPreserver.exe');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert(/^\d+\.\d+\.\d+$/.test(version));
await mkdir('.tmp', { recursive: true });
if (legacy) await mkdir(resolve('resources/win7-compat'), { recursive: true });
const metadata = resolve('.tmp/export-preserver-metadata.cs');
await writeFile(metadata, `using System.Reflection;\n[assembly: AssemblyTitle("Data Fusion Export Preserver")]\n[assembly: AssemblyDescription("Data Fusion export backup and restore")]\n[assembly: AssemblyProduct("Data Fusion Assistant")]\n[assembly: AssemblyCompany("Data Fusion Assistant")]\n[assembly: AssemblyVersion("${version}.0")]\n[assembly: AssemblyFileVersion("${version}.0")]\n`);
const framework = join(process.env.SystemRoot, 'Microsoft.NET/Framework64');
// Win7 includes CLR2 / .NET3.5. Do not require an extra .NET4 installation just
// to check a DLL and preserve exports. The modern helper keeps its CLR4 target.
const compiler = join(framework, legacy ? 'v3.5/csc.exe' : 'v4.0.30319/csc.exe');
const webExtensions = legacy
  ? join(process.env.SystemRoot, 'assembly/GAC_MSIL/System.Web.Extensions/3.5.0.0__31bf3856ad364e35/System.Web.Extensions.dll')
  : 'System.Web.Extensions.dll';
execFileSync(compiler,
  [...(legacy ? ['/noconfig', '/reference:System.dll'] : []), '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:' + webExtensions,
    '/out:' + output, source, resolve('resources/system-graphics.cs'), metadata], { windowsHide: true, encoding: 'utf8' });
if (legacy) {
  assert((await readFile(output)).includes(Buffer.from('v2.0.50727')), 'Win7 helper must target the built-in CLR2 runtime');
  // The fallback also allows this helper to run on modern Windows where only
  // CLR4 is enabled; Win7 selects its built-in runtime first.
  await writeFile(output + '.config', '<?xml version="1.0" encoding="utf-8"?>\n<configuration><startup><supportedRuntime version="v2.0.50727"/><supportedRuntime version="v4.0"/></startup></configuration>\n');
}
console.log(JSON.stringify({ status: 'built', nativeExportPreserver: true, powershellRequired: false,
  version, runtime: legacy ? 'CLR2-.NET3.5' : 'CLR4', sha256: createHash('sha256').update(await readFile(output)).digest('hex') }));
