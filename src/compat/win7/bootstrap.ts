import { app } from 'electron';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { installLegacyGlobals } from './globals';
import { installLegacySessionFetch } from './session-fetch';

const load = createRequire(join(dirname(process.execPath), 'data-fusion-runtime.cjs'));
installLegacyGlobals(load(join(process.resourcesPath, 'legacy-runtime', 'node_modules', 'undici')));
// Register before the main entry registers its own ready callback.
void app.whenReady().then(installLegacySessionFetch);
