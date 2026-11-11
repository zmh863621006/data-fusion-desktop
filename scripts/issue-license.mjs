import { sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [grantArg, privateKeyArg, outputArg] = process.argv.slice(2);
if (!grantArg || !privateKeyArg || !outputArg) {
  throw new Error('Usage: node scripts/issue-license.mjs <grant.json> <private.pem> <output.txt>');
}
const grant = JSON.parse(await readFile(resolve(grantArg), 'utf8'));
if (!grant.licenseId || !Number.isSafeInteger(grant.expiresAt) || !Array.isArray(grant.allowedSystems)) {
  throw new Error('grant.json must contain licenseId, expiresAt and allowedSystems');
}
const payload = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
const privateKey = await readFile(resolve(privateKeyArg), 'utf8');
const envelope = { payload, signature: sign('RSA-SHA256', Buffer.from(payload, 'base64url'), privateKey).toString('base64url'), algorithm: 'RSA-SHA256' };
const activationKey = `DFL1.${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
await writeFile(resolve(outputArg), activationKey, { encoding: 'utf8', mode: 0o600 });
console.log(`License written to ${resolve(outputArg)}`);
