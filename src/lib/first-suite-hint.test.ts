import { describe, expect, it } from 'vitest';
import { emptyProjectNextStep, firstSuiteNextSteps } from './first-suite-hint.js';

describe('firstSuiteNextSteps', () => {
  it('shows a frontend project the local environment beside the deployed one', () => {
    const text = firstSuiteNextSteps('P', 'frontend');
    expect(text).toContain(
      'testsprite project env create P --name default --url https://app.example.com',
    );
    expect(text).toContain(
      '(an app on this machine: testsprite project env create P --name local --url http://localhost:<port>)',
    );
    expect(text).toContain('testsprite plan --project P');
  });

  it('shows a backend project only a deployed API', () => {
    const text = firstSuiteNextSteps('P', 'backend');
    expect(text).toContain('--url https://api.example.com');
    expect(text).not.toContain('--local');
  });
});

describe('emptyProjectNextStep', () => {
  it('sends a project on this machine to the tunnel, then plan and apply, with no run command', () => {
    const text = emptyProjectNextStep('P', { environment: 'local', isDefault: true });
    expect(text).toContain(
      'keep testsprite tunnel start running in another terminal: testsprite plan --project P, then testsprite apply',
    );
    expect(text).not.toContain('testsprite run');
    expect(text).not.toContain('--diff');
    expect(text).not.toContain("can't open");
  });

  it('names an environment that is not the default in the request, as the agent explores the default', () => {
    expect(emptyProjectNextStep('P', { environment: 'Local dev', isDefault: false })).toContain(
      'testsprite plan "<what to test> on the Local dev environment" --project P, then testsprite apply',
    );
  });

  // No escape is safe in every shell: inside double quotes a POSIX shell runs
  // `$(…)` and backticks, and PowerShell runs `$(…)` and escapes with a backtick.
  it.each([
    'qa$(touch PWNED)',
    'qa"; touch PWNED; "',
    'qa\\$(touch PWNED)',
    'qa $HOME ${PATH}',
    'qa`touch PWNED`',
    'qa%PATH%',
    "Bob's QA",
  ])('leaves the environment name %s out of the command', name => {
    expect(emptyProjectNextStep('P', { environment: name, isDefault: false })).toContain(
      'testsprite plan "<what to test> on the <environment name> environment" --project P, then testsprite apply',
    );
  });

  it.each(['Local dev', 'staging-2', 'qa_env.v2', '本地 环境'])(
    'keeps the plain environment name %s in the command',
    name => {
      expect(emptyProjectNextStep('P', { environment: name, isDefault: false })).toContain(
        `testsprite plan "<what to test> on the ${name} environment" --project P, then testsprite apply`,
      );
    },
  );

  it.each([[{}], [{ environment: 'local' }], [{ environment: 'local', isDefault: true }]])(
    'keeps the plain plan when the environment is the default or not known (%j)',
    local => {
      expect(emptyProjectNextStep('P', local)).toContain(
        'testsprite plan --project P, then testsprite apply',
      );
    },
  );

  it('a project whose location is unknown names plan, apply and the API spec attachment', () => {
    const text = emptyProjectNextStep('P');
    expect(text).toContain('testsprite plan --project P, then testsprite apply');
    expect(text).toContain('attach its API spec with --file <spec>');
  });
});
