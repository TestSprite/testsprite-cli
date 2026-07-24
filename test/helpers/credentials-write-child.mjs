import { existsSync } from 'node:fs';
import { writeProfile } from '../../dist/lib/credentials.js';

const profile = process.env.CRED_PROFILE;
const credentialsPath = process.env.CRED_PATH;
const apiKey = process.env.CRED_API_KEY;
const startPath = process.env.CRED_START_PATH;

if (!profile || !credentialsPath || !apiKey || !startPath) {
  console.error('CRED_PROFILE, CRED_PATH, CRED_API_KEY, and CRED_START_PATH are required');
  process.exit(1);
}

const deadline = Date.now() + 5_000;
while (!existsSync(startPath)) {
  if (Date.now() >= deadline) {
    console.error(`Timed out waiting for start marker: ${startPath}`);
    process.exit(2);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

try {
  writeProfile(profile, { apiKey }, { path: credentialsPath });
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(3);
}
