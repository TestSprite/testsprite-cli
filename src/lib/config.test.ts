import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfigPath, loadConfig } from './config.js';
import { writeProfile } from './credentials.js';

let tmpRoot: string;
let credentialsPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'testsprite-config-'));
  credentialsPath = join(tmpRoot, 'credentials');
});

describe('loadConfig', () => {
  it.each([
    {
      env: { TESTSPRITE_API_KEY: ' sk-env ', TESTSPRITE_API_URL: ' https://env.example.com ' },
      endpointUrl: undefined,
      expectedUrl: 'https://env.example.com',
    },
    {
      env: { TESTSPRITE_API_KEY: 'sk-env' },
      endpointUrl: 'https://flag.example.com',
      expectedUrl: 'https://flag.example.com',
    },
    {
      env: { TESTSPRITE_API_KEY: 'sk-env', TESTSPRITE_API_URL: 'https://env.example.com' },
      endpointUrl: 'https://flag.example.com',
      expectedUrl: 'https://flag.example.com',
    },
  ])(
    'uses complete overrides without opening an unused credentials directory ($expectedUrl)',
    ({ env, endpointUrl, expectedUrl }) => {
      mkdirSync(credentialsPath);
      expect(loadConfig({ env, endpointUrl, credentialsPath })).toEqual({
        profile: 'default',
        apiKey: 'sk-env',
        apiUrl: expectedUrl,
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'uses complete overrides without reading an unreadable credentials file',
    () => {
      writeFileSync(credentialsPath, '[default]\napi_key = sk-file\n');
      chmodSync(credentialsPath, 0);
      try {
        expect(() => readFileSync(credentialsPath)).toThrowError(
          expect.objectContaining({ code: 'EACCES' }),
        );
        expect(
          loadConfig({
            env: { TESTSPRITE_API_KEY: 'sk-env', TESTSPRITE_API_URL: 'https://env.example.com' },
            credentialsPath,
          }),
        ).toEqual({
          profile: 'default',
          apiKey: 'sk-env',
          apiUrl: 'https://env.example.com',
        });
        expect(() =>
          loadConfig({ env: { TESTSPRITE_API_KEY: 'sk-env' }, credentialsPath }),
        ).toThrowError(expect.objectContaining({ code: 'EACCES' }));
      } finally {
        chmodSync(credentialsPath, 0o600);
      }
    },
  );

  it.each([
    { env: { TESTSPRITE_API_KEY: 'sk-env' }, endpointUrl: undefined },
    { env: { TESTSPRITE_API_URL: 'https://env.example.com' }, endpointUrl: undefined },
    { env: {}, endpointUrl: 'https://flag.example.com' },
    { env: { TESTSPRITE_API_KEY: 'sk-env', TESTSPRITE_API_URL: '  ' }, endpointUrl: undefined },
    {
      env: { TESTSPRITE_API_KEY: '  ', TESTSPRITE_API_URL: 'https://env.example.com' },
      endpointUrl: undefined,
    },
  ])(
    'retains filesystem errors when a missing field needs fallback ($env)',
    ({ env, endpointUrl }) => {
      mkdirSync(credentialsPath);
      expect(() => loadConfig({ env, endpointUrl, credentialsPath })).toThrowError(
        expect.objectContaining({ code: 'EISDIR' }),
      );
    },
  );

  it.each([
    { profile: 'bad/name', envProfile: undefined },
    { profile: undefined, envProfile: 'bad[name]' },
    { profile: '', envProfile: undefined },
  ])(
    'validates the selected profile before complete overrides or file access ($profile, $envProfile)',
    ({ profile, envProfile }) => {
      mkdirSync(credentialsPath);
      expect(() =>
        loadConfig({
          profile,
          credentialsPath,
          env: {
            TESTSPRITE_PROFILE: envProfile,
            TESTSPRITE_API_KEY: 'sk-env',
            TESTSPRITE_API_URL: 'https://env.example.com',
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    },
  );

  it.each([
    {
      env: { TESTSPRITE_API_KEY: 'sk-env' },
      endpointUrl: undefined,
      expectedKey: 'sk-env',
      expectedUrl: 'https://file.example.com',
    },
    {
      env: { TESTSPRITE_API_URL: 'https://env.example.com' },
      endpointUrl: undefined,
      expectedKey: 'sk-file',
      expectedUrl: 'https://env.example.com',
    },
    {
      env: {},
      endpointUrl: 'https://flag.example.com',
      expectedKey: 'sk-file',
      expectedUrl: 'https://flag.example.com',
    },
  ])(
    'fills only missing override fields from the selected profile ($expectedUrl)',
    ({ env, endpointUrl, expectedKey, expectedUrl }) => {
      writeProfile(
        'staging',
        { apiKey: 'sk-file', apiUrl: 'https://file.example.com' },
        { path: credentialsPath },
      );
      expect(loadConfig({ profile: 'staging', env, endpointUrl, credentialsPath })).toEqual({
        profile: 'staging',
        apiKey: expectedKey,
        apiUrl: expectedUrl,
      });
    },
  );

  it('returns built-in defaults when nothing is provided', () => {
    const config = loadConfig({ env: {}, credentialsPath });
    expect(config.apiUrl).toBe('https://api.testsprite.com');
    expect(config.apiKey).toBeUndefined();
    expect(config.profile).toBe('default');
  });

  it('honors TESTSPRITE_API_URL over the file', () => {
    writeProfile('default', { apiUrl: 'https://from-file.example.com' }, { path: credentialsPath });
    const config = loadConfig({
      env: { TESTSPRITE_API_URL: 'https://from-env.example.com' },
      credentialsPath,
    });
    expect(config.apiUrl).toBe('https://from-env.example.com');
  });

  it('honors TESTSPRITE_API_KEY over the file', () => {
    writeProfile('default', { apiKey: 'sk-from-file' }, { path: credentialsPath });
    const config = loadConfig({
      env: { TESTSPRITE_API_KEY: 'sk-from-env' },
      credentialsPath,
    });
    expect(config.apiKey).toBe('sk-from-env');
  });

  it('honors TESTSPRITE_PROFILE', () => {
    expect(loadConfig({ env: { TESTSPRITE_PROFILE: 'staging' }, credentialsPath }).profile).toBe(
      'staging',
    );
  });

  it('option.profile overrides env var', () => {
    expect(
      loadConfig({
        profile: 'option-profile',
        env: { TESTSPRITE_PROFILE: 'env-profile' },
        credentialsPath,
      }).profile,
    ).toBe('option-profile');
  });

  it('treats empty TESTSPRITE_PROFILE as unset (falls back to default)', () => {
    expect(loadConfig({ env: { TESTSPRITE_PROFILE: '' }, credentialsPath }).profile).toBe(
      'default',
    );
  });

  it('treats whitespace-only TESTSPRITE_PROFILE as unset (falls back to default)', () => {
    const config = loadConfig({ env: { TESTSPRITE_PROFILE: '   ' }, credentialsPath });
    expect(config.profile).toBe('default');
  });

  it('reads credentials from the default profile when TESTSPRITE_PROFILE is blank', () => {
    writeProfile('default', { apiKey: 'sk-default' }, { path: credentialsPath });
    const config = loadConfig({ env: { TESTSPRITE_PROFILE: '  ' }, credentialsPath });
    expect(config.apiKey).toBe('sk-default');
  });

  it('option.endpointUrl overrides everything', () => {
    writeProfile('default', { apiUrl: 'https://file' }, { path: credentialsPath });
    const config = loadConfig({
      endpointUrl: 'https://flag',
      env: { TESTSPRITE_API_URL: 'https://env' },
      credentialsPath,
    });
    expect(config.apiUrl).toBe('https://flag');
  });

  it('falls back to credentials file when env is unset', () => {
    writeProfile(
      'default',
      { apiKey: 'sk-file', apiUrl: 'https://from-file.example.com' },
      { path: credentialsPath },
    );
    const config = loadConfig({ env: {}, credentialsPath });
    expect(config.apiKey).toBe('sk-file');
    expect(config.apiUrl).toBe('https://from-file.example.com');
  });

  it('reads the requested profile, not just default', () => {
    writeProfile('dev', { apiKey: 'sk-dev' }, { path: credentialsPath });
    const config = loadConfig({ profile: 'dev', env: {}, credentialsPath });
    expect(config.apiKey).toBe('sk-dev');
  });

  it('treats empty / whitespace TESTSPRITE_API_URL as unset (falls through to profile)', () => {
    writeProfile(
      'default',
      { apiKey: 'sk-file', apiUrl: 'https://api.example.com:8443' },
      { path: credentialsPath },
    );
    const config = loadConfig({
      env: { TESTSPRITE_API_URL: '   ' },
      credentialsPath,
    });
    expect(config.apiUrl).toBe('https://api.example.com:8443');
  });

  it('treats empty / whitespace TESTSPRITE_API_KEY as unset (falls through to profile)', () => {
    writeProfile('default', { apiKey: 'sk-file' }, { path: credentialsPath });
    const config = loadConfig({
      env: { TESTSPRITE_API_KEY: '' },
      credentialsPath,
    });
    expect(config.apiKey).toBe('sk-file');
  });
});

describe('defaultConfigPath', () => {
  it('points to ~/.testsprite/config', () => {
    expect(defaultConfigPath()).toBe(join(homedir(), '.testsprite', 'config'));
  });
});
