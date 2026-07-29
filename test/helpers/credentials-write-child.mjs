import { existsSync, writeFileSync } from 'node:fs';
import { writeProfile } from '../../dist/lib/credentials.js';

const profile = process.env.CRED_PROFILE;
const credentialsPath = process.env.CRED_PATH;
const apiKey = process.env.CRED_API_KEY;
const startPath = process.env.CRED_START_PATH;
const readyPath = process.env.CRED_READY_PATH;
const startTimeoutMs = Number(process.env.CRED_START_TIMEOUT_MS ?? '5000');
const pollMs = Number(process.env.CRED_POLL_MS ?? '5');

if (!profile || !credentialsPath || !apiKey || !startPath) {
  console.error('CRED_PROFILE, CRED_PATH, CRED_API_KEY, and CRED_START_PATH are required');
  process.exit(1);
}

if (
  !Number.isInteger(startTimeoutMs) ||
  startTimeoutMs < 1 ||
  !Number.isInteger(pollMs) ||
  pollMs < 1
) {
  console.error('CRED_START_TIMEOUT_MS and CRED_POLL_MS must be positive integers');
  process.exit(1);
}

if (readyPath) {
  writeFileSync(readyPath, 'ready');
}

const deadline = Date.now() + startTimeoutMs;
while (!existsSync(startPath)) {
  if (Date.now() >= deadline) {
    console.error(`Timed out waiting for start marker: ${startPath}`);
    process.exit(2);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
}

try {
  writeProfile(profile, { apiKey }, { path: credentialsPath });
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(3);
}
