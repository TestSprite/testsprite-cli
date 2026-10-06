/**
 * VENDOR DELTA (not upstream). The CLI adds the two dial helpers, which its
 * port preflight reuses so the pre-charge probe dials the SAME candidate set
 * the client will dial at run time. Upstream endpoint defaults and dormant
 * unknown-client recovery exports are intentionally omitted.
 */

export {
  TunnelClient,
  BlockedTargetError,
  resolveDialCandidates,
  blockedTargetReason,
} from './client.js';
export type { TunnelClientOptions, StreamOpenRequestFrame, LogLevel } from './types.js';
export { ErrCode } from './types.js';
