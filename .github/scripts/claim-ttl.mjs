const MAINTAINER_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const HOUR_MS = 60 * 60 * 1000;

function latestAssignment(events, login) {
  return events
    .filter(event => event.event === 'assigned' && event.assignee?.login === login)
    .map(event => new Date(event.created_at))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
}

// Same keywords the PR gate (pr-triage.yml) accepts as an issue reference.
const ISSUE_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part\s+of|refs?|references?|related\s+to)\s*:?\s+#(\d+)/gi;

function referencesIssue(body, issueNumber) {
  return [...body.matchAll(ISSUE_REFERENCE)].some(match => Number(match[1]) === issueNumber);
}

// An open PR by the assignee keeps the claim alive only if its description
// links the issue the way the PR gate requires; a bare `#N` mention does not.
// If the timeline omits the PR body, fail safe and treat the PR as linked.
function hasOpenLinkedPr(events, login, issueNumber) {
  return events.some(event => {
    const pr = event.source?.issue;
    if (event.event !== 'cross-referenced' || !pr?.pull_request) return false;
    if (pr.state !== 'open' || pr.user?.login !== login) return false;
    return typeof pr.body !== 'string' || referencesIssue(pr.body, issueNumber);
  });
}

function readHours(value, fallback) {
  return value === undefined ? fallback : Number(value);
}

export function evaluateClaim({ events, login, issueNumber, now, since, warn, ttl }) {
  const assignedAt = latestAssignment(events, login);
  if (!assignedAt) return { action: 'skip', reason: 'no-assignment-event' };
  if (assignedAt < since) return { action: 'skip', reason: 'grandfathered' };
  if (hasOpenLinkedPr(events, login, issueNumber))
    return { action: 'skip', reason: 'linked-open-pr' };

  const age = (now.getTime() - assignedAt.getTime()) / HOUR_MS;
  if (age < warn) return { action: 'skip', reason: 'under-warning-age' };
  return { action: age >= ttl ? 'expired' : 'warn', assignedAt };
}

export async function run({ github, context, core, env, now = new Date() }) {
  const ttl = readHours(env.CLAIM_TTL_HOURS, 96);
  const warn = readHours(env.CLAIM_WARN_HOURS, 72);
  const since = new Date(env.CLAIM_TTL_SINCE);
  if (
    !Number.isFinite(ttl) ||
    !Number.isFinite(warn) ||
    ttl <= 0 ||
    warn <= 0 ||
    warn >= ttl ||
    Number.isNaN(since.getTime()) ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    core.setFailed('Invalid claim TTL configuration');
    return;
  }

  const { owner, repo } = context.repo;
  const dryRun = env.DRY_RUN === 'true';
  const permissions = new Map();
  const skipped = {};
  const skip = reason => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  let scanned = 0;
  let errored = 0;
  let warned = 0;
  let expired = 0;

  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    assignee: '*',
    per_page: 100,
  });
  for (const issue of issues) {
    if (issue.pull_request) {
      skip('pull-request');
      continue;
    }
    scanned++;
    try {
      if (issue.labels?.some(label => label === 'pinned' || label.name === 'pinned')) {
        skip('pinned');
        continue;
      }
      let events;
      let comments;
      for (const assignee of issue.assignees ?? []) {
        const login = assignee.login;
        if (!permissions.has(login)) {
          try {
            const response = await github.rest.repos.getCollaboratorPermissionLevel({
              owner,
              repo,
              username: login,
            });
            permissions.set(login, response.data.permission);
          } catch (error) {
            permissions.set(login, null);
            core.warning(`Permission lookup failed for @${login}: ${error.message}`);
          }
        }
        const permission = permissions.get(login);
        if (!permission) {
          skip('permission-unknown');
          continue;
        }
        if (MAINTAINER_PERMISSIONS.has(permission)) {
          skip('maintainer');
          continue;
        }

        events ??= await github.paginate(github.rest.issues.listEventsForTimeline, {
          owner,
          repo,
          issue_number: issue.number,
          per_page: 100,
        });
        const evaluation = evaluateClaim({
          events,
          login,
          issueNumber: issue.number,
          now,
          since,
          warn,
          ttl,
        });
        if (evaluation.action === 'skip') {
          skip(evaluation.reason);
          continue;
        }

        comments ??= await github.paginate(github.rest.issues.listComments, {
          owner,
          repo,
          issue_number: issue.number,
          per_page: 100,
        });
        const stage = evaluation.action;
        const { assignedAt } = evaluation;
        const marker = `<!-- claim-ttl:${stage}:${login}:${assignedAt.toISOString()} -->`;
        const alreadyCommented = comments.some(comment => (comment.body ?? '').includes(marker));
        if (stage === 'warn') {
          if (alreadyCommented) {
            skip('already-warned');
            continue;
          }
          if (dryRun) {
            core.info(`DRY_RUN: would warn @${login} on #${issue.number}`);
          } else {
            const body = `@${login}, your claim on this issue expires in about 24 hours unless you open a PR that links it (for example, \`Closes #${issue.number}\` or \`Part of #${issue.number}\`). You can re-claim later with \`/assign\` if the issue is still free.\n\n${marker}`;
            await github.rest.issues.createComment({
              owner,
              repo,
              issue_number: issue.number,
              body,
            });
            comments.push({ body });
          }
          warned++;
          continue;
        }

        if (dryRun) {
          core.info(`DRY_RUN: would expire @${login} on #${issue.number}`);
        } else {
          const { data: afterRemoval } = await github.rest.issues.removeAssignees({
            owner,
            repo,
            issue_number: issue.number,
            assignees: [login],
          });
          if (afterRemoval.assignees?.length === 0) {
            try {
              await github.rest.issues.removeLabel({
                owner,
                repo,
                issue_number: issue.number,
                name: 'in-progress',
              });
            } catch {
              // The label may already be absent; expiry must still succeed.
            }
          }
          if (!alreadyCommented) {
            const body = `@${login}, your claim expired after ${ttl} hours without a linked PR. This issue is open for others now, and you're welcome to \`/assign\` again if it's still free.\n\n${marker}`;
            await github.rest.issues.createComment({
              owner,
              repo,
              issue_number: issue.number,
              body,
            });
            comments.push({ body });
          }
        }
        expired++;
      }
    } catch (error) {
      errored++;
      core.warning(`Claim TTL sweep failed for #${issue.number}: ${error.message}`);
    }
  }

  core.info(
    `Claim TTL: scanned=${scanned} warned=${warned} expired=${expired} skipped=${JSON.stringify(skipped)} errored=${errored}`,
  );
  if (scanned > 0 && errored === scanned) {
    core.setFailed('Claim TTL sweep failed for every scanned issue');
  }
}
