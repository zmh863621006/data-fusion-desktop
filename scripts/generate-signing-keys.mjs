import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const privatePath = resolve(process.argv[2] ?? 'private/data-fusion-private.pem');
const publicPath = resolve(process.argv[3] ?? 'private/data-fusion-public.pem');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
await mkdir(dirname(privatePath), { recursive: true });
await mkdir(dirname(publicPath), { recursive: true });
await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
console.log(`Private key: ${privatePath}`);
console.log(`Public key:  ${publicPath}`);
console.log('Keep the private key outside the source repository and deployment package.');
