import { describe, expect, it } from 'vitest';
import { emptyProjectNextStep } from './first-suite-hint.js';

describe('emptyProjectNextStep', () => {
  it('with no target flags at all it suggests the bare run command', () => {
    const text = emptyProjectNextStep('P', {});
    expect(text).toContain('testsprite run <test-id>');
    expect(text).not.toContain('--local');
    expect(text).toContain('testsprite plan --project P --diff, then testsprite apply');
  });

  it('carries the port and a non-default host', () => {
    expect(emptyProjectNextStep('P', { host: '::1', port: 3000 })).toContain(
      'testsprite run <test-id> --local 3000 --local-host ::1',
    );
  });

  it('names the saved environment the tunnel came from instead of a port', () => {
    const text = emptyProjectNextStep('P', { environment: 'Local dev' });
    expect(text).toContain("testsprite run <test-id> --env 'Local dev'");
    expect(text).not.toContain('--local ');
  });

  it('keeps --env next to an explicit --local', () => {
    expect(emptyProjectNextStep('P', { port: 3000, environment: 'staging' })).toContain(
      "testsprite run <test-id> --local 3000 --env 'staging'",
    );
  });

  it('replays an explicit --target-url rather than the port it resolved to', () => {
    const text = emptyProjectNextStep('P', { port: 5173, targetUrl: 'http://localhost:5173' });
    expect(text).toContain('testsprite run <test-id> --target-url http://localhost:5173');
    expect(text).not.toContain('--local 5173');
  });

  it('quotes a target URL that is not a plain shell word', () => {
    expect(emptyProjectNextStep('P', { targetUrl: 'http://localhost:5173/?a=1&b=2' })).toContain(
      "--target-url 'http://localhost:5173/?a=1&b=2'",
    );
  });

  it('a project whose location is unknown names plan, apply and the API spec attachment', () => {
    const text = emptyProjectNextStep('P');
    expect(text).toContain('testsprite plan --project P, then testsprite apply');
    expect(text).toContain('attach its API spec with --file <spec>');
  });
});
