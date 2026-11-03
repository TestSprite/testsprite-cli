/**
 * The workspace's billing standing, as `GET /me` reports it under
 * `activeOrg.workspace` (backend `WorkspaceGateService.status`). `state` is
 * what the FE banners key on; `notice` is the refusal every write will get
 * while the workspace is paused, already worded — it is null while the
 * workspace can be written to.
 */
export interface WorkspaceStatus {
  state: 'ok' | 'pending' | 'paused';
  tier: string;
  notice: {
    title: string;
    message: string;
    cta: string;
    billingUrl: string;
  } | null;
}

/**
 * One line for the text renderers (`auth status`, `usage`) — undefined when
 * the workspace is simply on its plan, so the callers print nothing then.
 * `--output json` carries the whole object; this is the human reading of it.
 */
export function formatWorkspaceStatus(ws: WorkspaceStatus | undefined): string | undefined {
  if (!ws || ws.state === 'ok') return undefined;
  if (ws.notice)
    return `${ws.state} — ${ws.notice.message} ${ws.notice.cta}: ${ws.notice.billingUrl}`;
  if (ws.state === 'pending')
    return 'pending — a scheduled plan change or a payment retry is in progress; the workspace keeps working meanwhile';
  return ws.state;
}
