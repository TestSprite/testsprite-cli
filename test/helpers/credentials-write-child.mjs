import { writeProfile } from '../../dist/lib/credentials.js';

const profile = process.env.CRED_PROFILE;
const credentialsPath = process.env.CRED_PATH;
const apiKey = process.env.CRED_API_KEY;

if (!profile || !credentialsPath || !apiKey) {
  console.error('CRED_PROFILE, CRED_PATH, and CRED_API_KEY are required');
  process.exit(1);
}

await writeProfile(profile, { apiKey }, { path: credentialsPath });
