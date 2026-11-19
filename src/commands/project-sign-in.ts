import { ApiError } from '../lib/errors.js';

export type SignInMode = 'public' | 'account' | 'otp' | 'manual';

export function signInValidationError(message: string, reason = 'invalid_sign_in_flags'): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: message,
      requestId: 'local',
      details: { reason },
    },
  });
}

export function parseSignInMode(raw: string | undefined, flag: string): SignInMode {
  const aliases: Record<string, SignInMode> = {
    public: 'public',
    account: 'account',
    otp: 'otp',
    manual: 'manual',
    none: 'public',
    credentials: 'account',
    sso: 'manual',
  };
  if (raw === undefined && flag === '--mode')
    throw signInValidationError(
      '--mode is required: public, account or manual (otp can only be chosen with `project env create --sign-in otp`)',
    );
  const key = raw?.toLowerCase();
  const mode = key !== undefined && Object.hasOwn(aliases, key) ? aliases[key] : undefined;
  if (!mode)
    throw signInValidationError(
      `${flag} must be one of: public, account, otp, manual, none, credentials, sso.`,
    );
  return mode;
}

export function parseSessionTtl(raw: string): number {
  if (raw === 'never') return -1;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 2_592_000)
    throw signInValidationError(
      '--session-ttl must be an integer from 1 to 2592000 seconds, or never.',
    );
  return Number(raw);
}

export function validateSignInFlags(
  mode: SignInMode | undefined,
  opts: {
    username?: string;
    password?: string;
    passwordFile?: string;
    sessionTtl?: string;
    otpChannel?: string[];
  },
  requireAccountPair: boolean,
): void {
  if (opts.password !== undefined && opts.passwordFile !== undefined)
    throw signInValidationError('--password and --password-file are mutually exclusive.');
  if (opts.username !== undefined && !opts.username.trim())
    throw signInValidationError('--username must not be empty or whitespace-only.');
  if (opts.password !== undefined && !opts.password.trim())
    throw signInValidationError('--password must not be empty or whitespace-only.');
  if (mode !== undefined && mode !== 'account') {
    if (opts.username !== undefined)
      throw signInValidationError('--username is only valid with account sign-in.');
    if (opts.password !== undefined)
      throw signInValidationError('--password is only valid with account sign-in.');
    if (opts.passwordFile !== undefined)
      throw signInValidationError('--password-file is only valid with account sign-in.');
  }
  if (requireAccountPair && mode === 'account') {
    if (opts.username === undefined)
      throw signInValidationError('--username is required with --sign-in account.');
    if (opts.password === undefined && opts.passwordFile === undefined)
      throw signInValidationError(
        '--password or --password-file is required with --sign-in account.',
      );
  }
  if (opts.sessionTtl !== undefined && mode !== 'manual')
    throw signInValidationError('--session-ttl is only valid with manual sign-in.');
  if (opts.otpChannel !== undefined && mode !== 'otp')
    throw signInValidationError('--otp-channel is only valid with --sign-in otp.');
  if (opts.sessionTtl !== undefined) parseSessionTtl(opts.sessionTtl);
}
