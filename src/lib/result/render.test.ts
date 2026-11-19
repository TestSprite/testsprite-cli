import { describe, expect, it } from 'vitest';
import { renderEvidence, renderResultDetail, renderResultList } from './render.js';
import type { ResultDetail, ResultLine, ResultSignIn, ResultStep } from './types.js';

const LINE: ResultLine = {
  resultId: 'r1',
  runId: 'e1',
  caseKey: 'test_1',
  title: 'Checkout shows the order confirmation',
  testStatus: 'FAILED',
  processStatus: 'Idle',
  error: 'The confirmation heading never appeared.',
  blockedReason: null,
  environmentName: 'staging',
  created: '2026-11-10T08:00:00.000Z',
};

const step = (
  stepIndex: string,
  status: ResultStep['status'],
  description: string,
): ResultStep => ({
  stepIndex,
  type: 'action',
  action: 'click',
  description,
  status,
  selector: '#submit',
  url: 'https://staging.example.com/checkout',
  healed: false,
  screenshotSignedUrl: `https://storage.example.com/steps/${stepIndex}.png`,
  htmlSignedUrl: `https://storage.example.com/steps/${stepIndex}.html`,
});

const FAILED_STEP = step('3', 'failed', 'Expect the order confirmation heading');

const DETAIL: ResultDetail = {
  resultId: 'r1',
  runId: 'e1',
  caseKey: 'test_1',
  caseHash: 'hash_1',
  title: 'Checkout shows the order confirmation',
  type: 'frontend',
  testStatus: 'FAILED',
  processStatus: 'Idle',
  processErrorMessage: null,
  error: 'The confirmation heading never appeared.',
  cause: 'The submit button stayed disabled.',
  fix: 'Enable the button once the form validates.',
  blockedReason: null,
  videoUrl: 'https://storage.example.com/video/r1.mp4',
  envId: 'env_1',
  created: '2026-11-10T08:00:00.000Z',
  modified: '2026-11-10T08:01:00.000Z',
  failedStep: FAILED_STEP,
  steps: [
    step('1', 'passed', 'Click the cart icon'),
    step('2', 'passed', 'Fill the address'),
    FAILED_STEP,
  ],
  signIn: null,
};

const SIGN_IN: ResultSignIn = {
  id: 'auth_1',
  status: 'failed',
  videoUrl: 'https://storage.example.com/video/auth_1.mp4',
  finalUrl: 'https://staging.example.com/login',
  stepCount: 2,
  error: 'The sign-in page rejected the password.',
  steps: [
    { ...step('1', 'passed', "Fill '***' into the password field"), screenshotSignedUrl: null },
    { ...step('2', 'failed', 'Click the sign-in button'), screenshotSignedUrl: null },
  ],
};

describe('renderResultList', () => {
  it('prints one line per result: created, status, result id, run id, environment, title', () => {
    const lines = renderResultList({
      results: [LINE, { ...LINE, resultId: 'r0', runId: 'e0', testStatus: 'PASSED', error: null }],
    }).split('\n');
    // A header names the columns, so the result id and the run id cannot be mixed up.
    expect(lines[0]).toMatch(/^CREATED\s+STATUS\s+RESULT ID\s+RUN ID\s+ENV\s+TITLE$/);
    expect(lines.slice(1)).toEqual([
      '2026-11-10T08:00:00.000Z  FAILED  r1         e1      staging  Checkout shows the order confirmation',
      '2026-11-10T08:00:00.000Z  PASSED  r0         e0      staging  Checkout shows the order confirmation',
    ]);
  });

  it('keeps each result on one line when a title spans lines, and marks what the server left empty', () => {
    const text = renderResultList({
      results: [
        { ...LINE, title: 'Checkout\n  shows\tthe total', runId: null, environmentName: null },
      ],
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '2026-11-10T08:00:00.000Z  FAILED  r1         -       -    Checkout shows the total',
    );
  });

  it('says there are no results when the list is empty', () => {
    expect(renderResultList({ results: [], hiddenRunCount: 3, retentionDays: 30 })).toBe(
      'No results.',
    );
  });
});

describe('renderResultDetail', () => {
  it('leads with the status and title, then the ids, error, cause, fix, the failed step, steps and video', () => {
    expect(renderResultDetail(DETAIL).split('\n')).toEqual([
      'FAILED  Checkout shows the order confirmation',
      'resultId:       r1',
      'runId:          e1',
      'caseKey:        test_1',
      'error:          The confirmation heading never appeared.',
      'cause:          The submit button stayed disabled.',
      'fix:            Enable the button once the form validates.',
      'failedStep:     3  Expect the order confirmation heading',
      '  screenshot:   https://storage.example.com/steps/3.png',
      'steps:          3 (1 failed)',
      'videoUrl:       https://storage.example.com/video/r1.mp4',
    ]);
  });

  it('prints no step but the failed one: every step is in the JSON', () => {
    const text = renderResultDetail(DETAIL);
    expect(text).not.toContain('Click the cart icon');
    expect(text).not.toContain('Fill the address');
    expect(text).not.toContain('steps/1.png');
  });

  it('prints only what the result has: no cause, fix, failed step or video when the server sent none', () => {
    const passed: ResultDetail = {
      ...DETAIL,
      testStatus: 'PASSED',
      error: null,
      cause: null,
      fix: null,
      failedStep: null,
      videoUrl: null,
      steps: [step('1', 'passed', 'Click the cart icon')],
    };
    expect(renderResultDetail(passed).split('\n')).toEqual([
      'PASSED  Checkout shows the order confirmation',
      'resultId:       r1',
      'runId:          e1',
      'caseKey:        test_1',
      'steps:          1 (0 failed)',
    ]);
  });

  it.each([
    ['empty', ''],
    ['blank', ' \n\t '],
  ])(
    'prints only what the result has when the server sent %s strings instead of null',
    (_what, blank) => {
      const passed: ResultDetail = {
        ...DETAIL,
        testStatus: 'PASSED',
        processErrorMessage: blank,
        error: blank,
        cause: blank,
        fix: blank,
        blockedReason: blank,
        failedStep: null,
        videoUrl: blank,
        trace: blank,
        apiOutput: blank,
        steps: [step('1', 'passed', 'Click the cart icon')],
      };
      expect(renderResultDetail(passed).split('\n')).toEqual([
        'PASSED  Checkout shows the order confirmation',
        'resultId:       r1',
        'runId:          e1',
        'caseKey:        test_1',
        'steps:          1 (0 failed)',
      ]);
    },
  );

  it('shows where a result that has not finished stands', () => {
    const running = renderResultDetail({
      ...DETAIL,
      testStatus: 'RUNNING',
      processStatus: 'Executing',
      error: null,
      cause: null,
      fix: null,
      failedStep: null,
      steps: [],
    });
    expect(running).toContain('processStatus:  Executing');
    expect(renderResultDetail(DETAIL)).not.toContain('processStatus');
  });

  it('prints why a blocked result never ran, and its sign-in run', () => {
    const text = renderResultDetail({
      ...DETAIL,
      testStatus: 'BLOCKED',
      error: null,
      cause: null,
      fix: null,
      blockedReason: 'Sign-in failed, so the test never started.',
      failedStep: null,
      steps: [],
      videoUrl: null,
      signIn: SIGN_IN,
    });
    expect(text.split('\n')).toEqual([
      'BLOCKED  Checkout shows the order confirmation',
      'resultId:       r1',
      'runId:          e1',
      'caseKey:        test_1',
      'blockedReason:  Sign-in failed, so the test never started.',
      'steps:          0 (0 failed)',
      'signIn:         failed',
      '  error:        The sign-in page rejected the password.',
      '  stepCount:    2',
      '  failedStep:   2  Click the sign-in button',
    ]);
  });

  it('never adds a typed value back: a step prints its description as the server redacted it', () => {
    const text = renderResultDetail({
      ...DETAIL,
      failedStep: SIGN_IN.steps[0]!,
      signIn: { ...SIGN_IN, steps: [{ ...SIGN_IN.steps[0]!, status: 'failed' }] },
    });
    expect(text).toContain("Fill '***' into the password field");
    expect(text).not.toMatch(/#submit|selector|healed/);
  });

  it('indents the lines after the first of a value that spans lines', () => {
    const text = renderResultDetail({ ...DETAIL, cause: 'First line.\nSecond line.' });
    expect(text).toContain('cause:          First line.\n                Second line.');
  });

  it('keeps an id, a status or a URL on its line when the server split it', () => {
    const split = (value: string): string => `${value}\nstatus: PASSED`;
    const text = renderResultDetail({
      ...DETAIL,
      resultId: split('r1'),
      runId: split('run_1'),
      caseKey: split('TC001'),
      failedStep: {
        ...FAILED_STEP,
        screenshotSignedUrl: split('https://storage.example.com/2.png'),
      },
      videoUrl: split('https://storage.example.com/video/r1.mp4'),
      signIn: { ...SIGN_IN, status: split('failed'), stepCount: 2 },
    });
    expect(text.split('\n').filter(line => line.trimStart().startsWith('status:'))).toEqual([]);
    expect(text).toContain(
      'videoUrl:       https://storage.example.com/video/r1.mp4 status: PASSED',
    );
    // A result still running prints its process status, one line too.
    const running = renderResultDetail({
      ...DETAIL,
      testStatus: 'RUNNING',
      processStatus: split('Executing'),
    });
    expect(running).toContain('processStatus:  Executing status: PASSED');
    expect(running.split('\n').filter(line => line.trimStart().startsWith('status:'))).toEqual([]);
  });

  it('prints the process error, the only reason an integration failure carries', () => {
    const text = renderResultDetail({
      ...DETAIL,
      processStatus: 'Failed',
      processErrorMessage: 'A step uses an unresolved placeholder id. Regenerate the plan.',
      error: null,
      cause: null,
      fix: null,
      failedStep: null,
      steps: [],
    });
    expect(text.split('\n')).toEqual([
      'FAILED  Checkout shows the order confirmation',
      'resultId:       r1',
      'runId:          e1',
      'caseKey:        test_1',
      'processError:   A step uses an unresolved placeholder id. Regenerate the plan.',
      'steps:          0 (0 failed)',
      'videoUrl:       https://storage.example.com/video/r1.mp4',
    ]);
  });

  it('prints the process error of a result still running, beside its process status', () => {
    const text = renderResultDetail({
      ...DETAIL,
      testStatus: 'RUNNING',
      processStatus: 'Failed',
      processErrorMessage: 'The run report could not be read.',
      error: null,
    });
    expect(text).toContain(
      'processStatus:  Failed\nprocessError:   The run report could not be read.',
    );
  });

  it('prints the process error once when it is the error', () => {
    const text = renderResultDetail({ ...DETAIL, processErrorMessage: DETAIL.error });
    expect(text).toContain('error:          The confirmation heading never appeared.');
    expect(text).not.toContain('processError');
  });

  it('prints no process status for a cancelled result', () => {
    const text = renderResultDetail({ ...DETAIL, testStatus: 'CANCELLED', processStatus: 'Idle' });
    expect(text).not.toContain('processStatus');
  });

  it('counts the sign-in steps when the server sent no step count', () => {
    const text = renderResultDetail({ ...DETAIL, signIn: { ...SIGN_IN, stepCount: null } });
    expect(text).toContain('  stepCount:    2');
  });

  it('marks ids and sign-in fields the server left empty', () => {
    const text = renderResultDetail({
      ...DETAIL,
      runId: null,
      caseKey: null,
      failedStep: { ...FAILED_STEP, stepIndex: null, description: null, screenshotSignedUrl: null },
      signIn: { ...SIGN_IN, status: null, error: null, stepCount: null, steps: [] },
    });
    expect(text).toContain('runId:          -');
    expect(text).toContain('caseKey:        -');
    expect(text).toContain('failedStep:     -  (no description)');
    expect(text).not.toContain('  screenshot:');
    expect(text).toContain('signIn:         -\n  stepCount:    0');
  });
  it('marks ids, a step and sign-in fields the server sent empty, as when it sent null', () => {
    const text = renderResultDetail({
      ...DETAIL,
      testStatus: 'RUNNING',
      processStatus: ' ',
      runId: '',
      caseKey: ' ',
      failedStep: { ...FAILED_STEP, stepIndex: '', description: ' ', screenshotSignedUrl: '' },
      signIn: { ...SIGN_IN, status: '', error: ' ', stepCount: null, steps: [] },
    });
    expect(text).not.toContain('processStatus');
    expect(text).toContain('runId:          -');
    expect(text).toContain('caseKey:        -');
    expect(text).toContain('failedStep:     -  (no description)');
    expect(text).not.toContain('  screenshot:');
    expect(text).toContain('signIn:         -\n  stepCount:    0');
    expect(text).not.toContain('  error:');
  });
});

describe("a backend test's traceback and output", () => {
  /** A failed backend test: no steps, no video. */
  const BACKEND: ResultDetail = {
    ...DETAIL,
    title: 'Create order returns 201',
    type: 'BACKEND',
    error: 'AssertionError: expected 201, got 500',
    cause: 'The orders endpoint fails when the cart is empty.',
    fix: 'Return 400 for an empty cart.',
    videoUrl: null,
    failedStep: null,
    steps: [],
  };
  const HEAD = [
    'FAILED  Create order returns 201',
    'resultId:       r1',
    'runId:          e1',
    'caseKey:        test_1',
    'error:          AssertionError: expected 201, got 500',
    'cause:          The orders endpoint fails when the cart is empty.',
    'fix:            Return 400 for an empty cart.',
    'steps:          0 (0 failed)',
  ];
  const POINTER = '--output json, or --out <dir> for result.json';
  /** `count` lines, `<name> 1` to `<name> <count>`. */
  const numbered = (name: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${name} ${i + 1}`);

  it('prints the traceback, then the output, each under its label after the rest', () => {
    const text = renderResultDetail({
      ...BACKEND,
      trace:
        'Traceback (most recent call last):\n' +
        '  File "/var/task/test_orders.py", line 12, in test_create_order\n' +
        '    assert resp.status_code == 201\n' +
        'AssertionError: expected 201, got 500\n',
      apiOutput: 'POST https://api.example.com/orders\nstatus 500\n',
    });
    expect(text.split('\n')).toEqual([
      ...HEAD,
      'trace:',
      '  Traceback (most recent call last):',
      '    File "/var/task/test_orders.py", line 12, in test_create_order',
      '      assert resp.status_code == 201',
      '  AssertionError: expected 201, got 500',
      'apiOutput:',
      '  POST https://api.example.com/orders',
      '  status 500',
    ]);
  });

  it("keeps the traceback's last 20 lines and the output's first 20, each pointer where the cut is", () => {
    const text = renderResultDetail({
      ...BACKEND,
      trace: `${numbered('trace', 45).join('\n')}\n`,
      apiOutput: numbered('output', 30).join('\n'),
    });
    expect(text.split('\n')).toEqual([
      ...HEAD,
      'trace:',
      // A traceback loses its earlier lines, so its pointer stands above what is kept.
      `  (25 earlier lines: ${POINTER})`,
      ...numbered('trace', 45)
        .slice(25)
        .map(line => `  ${line}`),
      'apiOutput:',
      ...numbered('output', 20).map(line => `  ${line}`),
      `  (10 more lines: ${POINTER})`,
    ]);
  });

  it('prints 20 lines whole, and counts one line over as one more line', () => {
    const text = renderResultDetail({
      ...BACKEND,
      trace: numbered('trace', 20).join('\n'),
      apiOutput: numbered('output', 21).join('\n'),
    });
    const lines = text.split('\n');
    expect(lines.filter(line => line.includes(POINTER))).toEqual([`  (1 more line: ${POINTER})`]);
    expect(lines).toContain('  trace 1');
    expect(lines).toContain('  output 20');
    expect(lines).not.toContain('  output 21');
  });

  it('counts a carriage return as the line break the terminal would make of it', () => {
    const text = renderResultDetail({ ...BACKEND, trace: numbered('trace', 25).join('\r') });
    expect(text).not.toContain('\r');
    expect(text.split('\n').slice(HEAD.length)).toEqual([
      'trace:',
      `  (5 earlier lines: ${POINTER})`,
      ...numbered('trace', 25)
        .slice(5)
        .map(line => `  ${line}`),
    ]);
  });

  it('keeps the first 2000 characters of a one-line output, and says how many more there are', () => {
    const json = `{"data":"${'x'.repeat(9989)}"}`;
    expect(json).toHaveLength(10_000);
    const text = renderResultDetail({ ...BACKEND, apiOutput: json });
    expect(text.split('\n').slice(HEAD.length)).toEqual([
      'apiOutput:',
      `  ${json.slice(0, 2000)}`,
      `  (8000 more characters: ${POINTER})`,
    ]);
  });

  it('keeps the last 2000 characters of a one-line traceback, where the exception is', () => {
    const trace = `Traceback: ${'frame '.repeat(1000)}AssertionError: expected 201, got 500`;
    const text = renderResultDetail({ ...BACKEND, trace });
    expect(text.split('\n').slice(HEAD.length)).toEqual([
      'trace:',
      `  (${trace.length - 2000} earlier characters: ${POINTER})`,
      `  ${trace.slice(-2000)}`,
    ]);
    expect(text).toContain('AssertionError: expected 201, got 500');
  });

  it('cuts characters from the 20 lines it kept, and counts both', () => {
    // Each line is 200 characters, so 20 lines and their 19 line breaks are 4019.
    const lines = (name: string) => numbered(name, 25).map(line => line.padEnd(200, '.'));
    const text = renderResultDetail({
      ...BACKEND,
      trace: lines('trace').join('\n'),
      apiOutput: lines('output').join('\n'),
    });
    const printed = text.split('\n').slice(HEAD.length);
    const kept = (from: string[]) => from.join('\n');
    expect(printed[0]).toBe('trace:');
    expect(printed[1]).toBe(`  (5 earlier lines and 2019 characters: ${POINTER})`);
    const apiAt = printed.indexOf('apiOutput:');
    const shownTrace = printed.slice(2, apiAt).map(line => line.slice(2));
    expect(kept(shownTrace)).toBe(kept(lines('trace').slice(5)).slice(-2000));
    expect(printed.at(-1)).toBe(`  (5 more lines and 2019 characters: ${POINTER})`);
    const shownOutput = printed.slice(apiAt + 1, -1).map(line => line.slice(2));
    expect(kept(shownOutput)).toBe(kept(lines('output').slice(0, 20)).slice(0, 2000));
  });

  it('prints 2000 characters whole, and never splits a character in two', () => {
    const whole = renderResultDetail({ ...BACKEND, apiOutput: 'x'.repeat(2000) });
    expect(whole).not.toContain(POINTER);
    // Each emoji is two UTF-16 code units and one character. With the extra
    // `a`, both cuts fall in the middle of an emoji's two code units.
    const emoji = '\u{1F600}';
    const text = renderResultDetail({
      ...BACKEND,
      trace: `${emoji.repeat(3000)}a`,
      apiOutput: `a${emoji.repeat(3000)}`,
    });
    expect(text.split('\n').slice(HEAD.length)).toEqual([
      'trace:',
      `  (1001 earlier characters: ${POINTER})`,
      `  ${emoji.repeat(1999)}a`,
      'apiOutput:',
      `  a${emoji.repeat(1999)}`,
      `  (1001 more characters: ${POINTER})`,
    ]);
  });

  it('prints no empty line where a character cut falls on a line break', () => {
    // 199 characters and a line break each: the 2000th character of the 20
    // lines kept is the line break after the tenth.
    const lines = (name: string) => numbered(name, 25).map(line => line.padEnd(199, '.'));
    const text = renderResultDetail({
      ...BACKEND,
      trace: lines('trace').join('\n'),
      apiOutput: lines('output').join('\n'),
    });
    expect(text.split('\n').slice(HEAD.length)).toEqual([
      'trace:',
      `  (5 earlier lines and 1999 characters: ${POINTER})`,
      ...lines('trace')
        .slice(15)
        .map(line => `  ${line}`),
      'apiOutput:',
      ...lines('output')
        .slice(0, 10)
        .map(line => `  ${line}`),
      `  (5 more lines and 1999 characters: ${POINTER})`,
    ]);
  });

  it('leaves out the blank lines around a value, so they take none of the 20', () => {
    const text = renderResultDetail({
      ...BACKEND,
      apiOutput: `\n\n${numbered('output', 20).join('\n')}\n\n\n`,
    });
    expect(text.split('\n').slice(HEAD.length)).toEqual([
      'apiOutput:',
      ...numbered('output', 20).map(line => `  ${line}`),
    ]);
  });

  it.each([
    ['absent, as from an older backend', {}],
    ['null', { trace: null, apiOutput: null }],
    ['empty', { trace: '', apiOutput: '' }],
    ['blank', { trace: '\n  \n', apiOutput: ' \r\n' }],
  ])('prints neither block when they are %s', (_what, fields) => {
    expect(renderResultDetail({ ...BACKEND, ...fields }).split('\n')).toEqual(HEAD);
  });

  it('never prints them on a list line, whatever the line carries', () => {
    const text = renderResultList({
      results: [{ ...LINE, trace: 'Traceback', apiOutput: 'status 500' } as ResultLine],
    });
    expect(text).not.toMatch(/Traceback|status 500/);
  });
});

describe('server text that carries terminal escape sequences', () => {
  /**
   * Sets the window title, opens a hyperlink, clears the screen, colours, then
   * an 8-bit CSI and a bare 8-bit OSC introducer and ST (each removed alone; an
   * 8-bit introducer starts no sequence, so it carries no payload here).
   */
  const EVIL =
    '\u001b]0;pwned\u0007\u001b]8;;https://evil.example\u001b\\\u001b[2J\u001b[31m' +
    '\u009b1m\u009d\u009c\u202e\u2066\u200f';
  /** Any C0 or C1 control character but line feed, ESC included, or a bidi control. */
  const CONTROL =
    // eslint-disable-next-line no-control-regex -- finding control characters is the point.
    /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

  /** `value` with EVIL around every string in it, however deep. */
  const poison = <T>(value: T): T => {
    if (typeof value === 'string') return `${EVIL}${value}${EVIL}` as T;
    if (Array.isArray(value)) return value.map(poison) as T;
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, poison(inner)]),
      ) as T;
    }
    return value;
  };

  /** A detail in which every field the renderer can print is set. */
  const FULL: ResultDetail = {
    ...DETAIL,
    processStatus: 'Failed',
    processErrorMessage: 'The flow could not start.',
    blockedReason: 'Sign-in failed.',
    signIn: SIGN_IN,
    trace: 'Traceback (most recent call last):\nAssertionError',
    apiOutput: 'POST /orders\nstatus 500',
  };

  it.each([
    ['a list line', () => renderResultList({ results: [poison(LINE)] }), ['RESULT ID']],
    [
      'a finished detail, every field poisoned',
      () => renderResultDetail(poison(FULL)),
      [
        'processError:',
        'blockedReason:',
        'failedStep:',
        '  screenshot:',
        'videoUrl:',
        'signIn:',
        'trace:',
        '  AssertionError',
        'apiOutput:',
        '  status 500',
      ],
    ],
    [
      'a running detail, every field poisoned but its status',
      () => renderResultDetail({ ...poison(FULL), testStatus: 'RUNNING' }),
      ['RUNNING  ', 'processStatus:', 'processError:'],
    ],
    [
      'a download: the files written, and those not with their reasons',
      () =>
        renderEvidence({
          dir: '/tmp/evidence',
          written: [...poison(['video.mp4']), 'result.json'],
          failed: poison([{ file: 'steps/002.png', reason: 'HTTP 403' }]),
        }),
      [
        'Wrote 1 of 2 evidence files, and result.json, to /tmp/evidence',
        'Not downloaded:',
        'steps/002.png  HTTP 403',
      ],
    ],
  ])('never reaches the text of %s', (_what, render, labels) => {
    const text = render();
    expect(text).not.toMatch(CONTROL);
    expect(text).not.toContain('pwned');
    expect(text).not.toContain('evil.example');
    for (const label of labels) expect(text).toContain(label);
  });

  it('never reaches the list: title, environment and ids print without it', () => {
    const text = renderResultList({
      results: [
        {
          ...LINE,
          title: `${EVIL}Checkout\rshows the total`,
          environmentName: `stag${EVIL}ing`,
          resultId: `r1${EVIL}`,
          testStatus: `FAILED${EVIL}`,
        },
      ],
    });
    expect(text).not.toMatch(CONTROL);
    expect(text).not.toContain('pwned');
    expect(text).not.toContain('evil.example');
    expect(text.split('\n')[1]).toMatch(/FAILED\s+r1\s+e1\s+staging\s+Checkout shows the total$/);
  });

  it('never reaches the detail, and a multi-line value keeps its lines', () => {
    const text = renderResultDetail({
      ...DETAIL,
      title: `${EVIL}Checkout`,
      error: `${EVIL}The heading never appeared.`,
      cause: `First line.${EVIL}\r\nSecond line.`,
      fix: `Enable it.${EVIL}`,
      videoUrl: `https://storage.example.com/video/r1.mp4${EVIL}`,
      failedStep: {
        ...FAILED_STEP,
        stepIndex: `3${EVIL}`,
        description: `${EVIL}Expect the heading`,
        screenshotSignedUrl: `${EVIL}https://storage.example.com/steps/3.png`,
      },
      signIn: {
        ...SIGN_IN,
        status: `failed${EVIL}`,
        error: `${EVIL}Rejected.`,
        steps: [{ ...SIGN_IN.steps[1]!, description: `Click${EVIL} sign in` }],
      },
    });
    expect(text).not.toMatch(CONTROL);
    expect(text).not.toContain('pwned');
    expect(text).not.toContain('evil.example');
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'FAILED  Checkout',
        'error:          The heading never appeared.',
        'cause:          First line.',
        '                Second line.',
        'fix:            Enable it.',
        'failedStep:     3  Expect the heading',
        '  screenshot:   https://storage.example.com/steps/3.png',
        'videoUrl:       https://storage.example.com/video/r1.mp4',
        'signIn:         failed',
        '  error:        Rejected.',
        '  failedStep:   2  Click sign in',
      ]),
    );
  });
});

describe('renderEvidence', () => {
  it('says when a file that did not download kept its earlier copy', () => {
    const text = renderEvidence({
      dir: '/out',
      written: ['steps/001.png', 'result.json'],
      failed: [
        { file: 'video.webm', reason: 'HTTP 403', kept: true },
        { file: 'steps/002.png', reason: 'HTTP 403' },
      ],
    });
    expect(text.split('\n').slice(-2)).toEqual([
      '  video.webm  HTTP 403 (the earlier copy is kept)',
      '  steps/002.png  HTTP 403',
    ]);
  });

  it('counts evidence files, result.json apart, whatever was written', () => {
    const counted = (written: string[], failed: string[] = []) =>
      renderEvidence({
        dir: '/d',
        written,
        failed: failed.map(file => ({ file, reason: 'HTTP 403' })),
      }).split('\n')[0];
    expect(counted(['result.json'])).toBe('Wrote 0 evidence files, and result.json, to /d');
    expect(counted(['video.mp4', 'result.json'])).toBe(
      'Wrote 1 evidence file, and result.json, to /d',
    );
    expect(counted(['result.json'], ['video.mp4'])).toBe(
      'Wrote 0 of 1 evidence file, and result.json, to /d',
    );
  });
});
