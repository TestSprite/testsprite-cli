/**
 * The agent conversation as `/api/cli/v1/projects/{id}/conversations` returns
 * it: the same conversation the portal shows, read by polling.
 */

/**
 * - `working`: the agent is at work.
 * - `proposed`: it proposed something (a plan, an environment, a run) and waits for apply or reject.
 * - `replied`: its turn is over; read the reply, then answer it or stop there.
 * - `stopped`: it stopped short (asked to, its task discarded, out of credits, its budget, an
 *   error, a refusal); `stopReason` says which.
 * - `ended`: the conversation can't go on; start a new one.
 */
export type ConversationState = 'working' | 'proposed' | 'replied' | 'stopped' | 'ended';

export type ConversationEvent =
  | { seq: number; at: string; kind: 'message'; from: 'agent' | 'user'; text: string }
  | { seq: number; at: string; kind: 'activity'; text: string }
  | { seq: number; at: string; kind: 'error'; text: string };

export interface PlanStep {
  type: 'action' | 'assertion';
  description: string;
}

export interface PlanTest {
  ref: string;
  useCase: string;
  title: string;
  priority: string;
  description: string;
  steps: PlanStep[];
}

export interface PlanChange {
  ref: string;
  title: string;
  useCase?: string;
  priority?: string;
  description?: string;
  steps?: PlanStep[];
}

export interface Proposal {
  /** The card's id: what `apply` and `reject` decide. */
  id: string;
  kind:
    | 'plan'
    | 'environments'
    | 'schedules'
    | 'project'
    | 'docs'
    | 'fixtures'
    | 'run'
    | 'secret'
    | 'question'
    | 'action';
  summary: string;
  /** The agent's one line on what the change does and why. */
  message?: string;
  plan?: { added: PlanTest[]; changed: PlanChange[]; removed: Array<{ ref: string }> };
  changes?: Array<{ op: string; name: string; detail?: string }>;
  /** A secret card: the secret a person types to apply it, which goes to this environment. */
  secret?: { environment: string; field: string; header?: string };
  /** A run card: the tests, and the environment the run goes to (`apply --env` picks another). */
  run?: { tests: string[]; environment?: RunEnvironment };
  /** A question card: applying it answers each question (`apply --answer`). */
  questions?: Question[];
  problems?: Array<{ path: string; reason: string }>;
}

export interface Question {
  question: string;
  /** A few words naming the question, as the portal's card tabs it. */
  header: string;
  options: Array<{ label: string; description: string }>;
  /** Several options may be picked; the answer lists their labels, comma-separated. */
  multiSelect: boolean;
}

/** Where a run card's run goes: the environment the agent named, else the project's default. */
export interface RunEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string | null;
  url: string;
  state: ConversationState;
  stopReason?: string;
  model: string;
  lastSeq: number;
  events: ConversationEvent[];
  proposal: Proposal | null;
  reply: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  state: ConversationState;
  lastMessageAt: string;
  url: string;
}

export interface ApplyResult {
  applied: string;
  ok: boolean;
  saved?: Array<{ path: string; detail: string; title?: string }>;
  failed?: Array<{ path: string; error: string }>;
  tests?: string[];
  /** A run the proposal started. `runId` is the wire name of its launch; `environment` names where it runs. */
  run?: { runId: string; tests: string[]; environment?: string };
  message?: string;
}

/** An {@link ApplyResult} as it is printed: the launch of a run it started is `run.runId`. */

/** What the CLI tells the agent about who started the conversation and from where. */
export interface Brief {
  caller: 'agent' | 'person';
  repository?: { name?: string; branch?: string; commit?: string };
  change?: string;
}
