/**
 * VENDOR DELTA (not upstream). Upstream's `index.ts` re-exports only
 * `TunnelClient` / `BlockedTargetError`; this adds the two dial helpers,
 * which the CLI's port preflight reuses so the pre-charge probe dials the
 * SAME candidate set the client will dial at run time.
 */

export {
  TunnelClient,
  BlockedTargetError,
  resolveDialCandidates,
  blockedTargetReason,
} from './client.js';
export type { TunnelClientOptions, StreamOpenRequestFrame, LogLevel } from './types.js';
export { ErrCode } from './types.js';
