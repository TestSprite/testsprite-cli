import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../version.js';
import {
  DEFAULT_SKILLS,
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
  ONBOARD_CODEX_LINE,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILLS,
  TARGETS,
  bodyHash12,
  buildCodexAggregate,
  buildSkillMarker,
  codexContentFor,
  loadCodexSkillBody,
  loadSkillBody,
  loadSkillBodyFor,
  parseSkillMarker,
  pathFor,
  renderForTarget,
  renderOwnFileWithMarker,
} from './agent-targets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `description:` value out of a YAML frontmatter block.
 * The frontmatter is delimited by `---` lines at the top of the file.
 * The description value is a single line (no folded/literal block scalars).
 */
function parseFrontmatterDescription(content: string): string | undefined {
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        // End of frontmatter
        break;
      }
    }
    if (inFrontmatter && line.startsWith('description: ')) {
      return line.slice('description: '.length);
    }
  }
  return undefined;
}

// Load skill-template.md from repo root (vitest cwd = repo root).
const templateRaw = readFileSync('docs/cli-v1-agent-install/skill-template.md', 'utf8');
const templateDescription = parseFrontmatterDescription(templateRaw);

// Load onboard-skill-template.md from repo root.
const onboardTemplateRaw = readFileSync(
  'docs/cli-v1-agent-install/onboard-skill-template.md',
  'utf8',
);
const onboardTemplateDescription = parseFrontmatterDescription(onboardTemplateRaw);

// Stub body for unit tests that don't need the real file, so tests are fast
// and deterministic regardless of asset path resolution.
const STUB_BODY = `# TestSprite Verification Loop

The verification-loop autopilot

testsprite test run <test-id> --wait --target-url <url> --timeout 600

testsprite test artifact get <run-id> --out ./out/
`;

// ---------------------------------------------------------------------------
// TARGETS shape
// ---------------------------------------------------------------------------

describe('TARGETS', () => {
  it('has all eight required keys', () => {
    const keys = Object.keys(TARGETS).sort();
    expect(keys).toEqual([
      'antigravity',
      'claude',
      'cline',
      'codex',
      'copilot',
      'cursor',
      'kiro',
      'windsurf',
    ]);
  });

  it('claude is GA', () => {
    expect(TARGETS.claude.status).toBe('ga');
  });

  it('cursor, cline, windsurf, copilot, antigravity, kiro, and codex are experimental', () => {
    expect(TARGETS.cursor.status).toBe('experimental');
    expect(TARGETS.cline.status).toBe('experimental');
    expect(TARGETS.windsurf.status).toBe('experimental');
    expect(TARGETS.copilot.status).toBe('experimental');
    expect(TARGETS.antigravity.status).toBe('experimental');
    expect(TARGETS.kiro.status).toBe('experimental');
    expect(TARGETS.codex.status).toBe('experimental');
  });

  it('each target has a non-empty POSIX path', () => {
    for (const [, spec] of Object.entries(TARGETS)) {
      expect(spec.path.length).toBeGreaterThan(0);
      expect(spec.path).not.toContain('\\');
    }
  });

  it('own-file targets have mode own-file', () => {
    expect(TARGETS.claude.mode).toBe('own-file');
    expect(TARGETS.antigravity.mode).toBe('own-file');
    expect(TARGETS.cursor.mode).toBe('own-file');
    expect(TARGETS.cline.mode).toBe('own-file');
    expect(TARGETS.kiro.mode).toBe('own-file');
    expect(TARGETS.windsurf.mode).toBe('own-file');
    expect(TARGETS.copilot.mode).toBe('own-file');
  });

  it('codex target has mode managed-section', () => {
    expect(TARGETS.codex.mode).toBe('managed-section');
  });

  it('codex target path is AGENTS.md', () => {
    expect(TARGETS.codex.path).toBe('AGENTS.md');
  });
});

// ---------------------------------------------------------------------------
// SKILL_DESCRIPTION
// ---------------------------------------------------------------------------

describe('SKILL_DESCRIPTION', () => {
  it('is ≤ 1536 characters (claude description cap)', () => {
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1536);
  });

  it('is byte-identical to skill-template.md frontmatter description', () => {
    expect(templateDescription).toBeDefined();
    expect(SKILL_DESCRIPTION).toBe(templateDescription);
  });

  it('begins with TestSprite', () => {
    expect(SKILL_DESCRIPTION.startsWith('TestSprite')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SKILL_NAME
// ---------------------------------------------------------------------------

describe('SKILL_NAME', () => {
  it('is "testsprite-verify"', () => {
    expect(SKILL_NAME).toBe('testsprite-verify');
  });
});

// ---------------------------------------------------------------------------
// loadSkillBody
// ---------------------------------------------------------------------------

describe('loadSkillBody', () => {
  it('returns a non-empty string when using the injectable read stub', () => {
    const body = loadSkillBody(() => STUB_BODY);
    expect(body).toBe(STUB_BODY);
  });

  it('real loadSkillBody() reads the actual asset and starts with the TestSprite Verification Loop H1', () => {
    // This exercises the real URL resolution path — proves the asset is reachable.
    const body = loadSkillBody();
    expect(body.length).toBeGreaterThan(0);
    expect(body.trimStart().startsWith('# TestSprite Verification Loop')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderForTarget — frontmatter shape per target
// ---------------------------------------------------------------------------

describe('renderForTarget("claude")', () => {
  const result = renderForTarget('claude', 'testsprite-verify', STUB_BODY);

  it('returns the correct path', () => {
    expect(result.path).toBe('.claude/skills/testsprite-verify/SKILL.md');
  });

  it('frontmatter contains name: testsprite-verify', () => {
    expect(result.content).toContain('name: testsprite-verify');
  });

  it('frontmatter contains description:', () => {
    expect(result.content).toContain(`description: ${SKILL_DESCRIPTION}`);
  });

  it('content ends with a trailing newline', () => {
    expect(result.content.endsWith('\n')).toBe(true);
  });
});

describe('renderForTarget("antigravity")', () => {
  const result = renderForTarget('antigravity', 'testsprite-verify', STUB_BODY);

  it('returns the correct path', () => {
    expect(result.path).toBe('.agents/skills/testsprite-verify/SKILL.md');
  });

  it('frontmatter contains name: testsprite-verify', () => {
    expect(result.content).toContain('name: testsprite-verify');
  });

  it('frontmatter contains description:', () => {
    expect(result.content).toContain(`description: ${SKILL_DESCRIPTION}`);
  });
});

describe('renderForTarget("kiro")', () => {
  const result = renderForTarget('kiro', 'testsprite-verify', STUB_BODY);

  it('returns the correct path', () => {
    expect(result.path).toBe('.kiro/skills/testsprite-verify/SKILL.md');
  });

  it('frontmatter contains name: testsprite-verify', () => {
    expect(result.content).toContain('name: testsprite-verify');
  });

  it('frontmatter contains description:', () => {
    expect(result.content).toContain(`description: ${SKILL_DESCRIPTION}`);
  });
});

describe('renderForTarget("claude") vs renderForTarget("antigravity")', () => {
  it('produce the same frontmatter lines (name + description)', () => {
    const claude = renderForTarget('claude', 'testsprite-verify', STUB_BODY);
    const antigravity = renderForTarget('antigravity', 'testsprite-verify', STUB_BODY);

    // Extract the frontmatter block from each
    const extractFrontmatter = (content: string): string => {
      const match = /^---\n([\s\S]*?)\n---/.exec(content);
      return match?.[1] ?? '';
    };

    expect(extractFrontmatter(claude.content)).toBe(extractFrontmatter(antigravity.content));
  });

  it('differ only in their landing path', () => {
    const claude = renderForTarget('claude', 'testsprite-verify', STUB_BODY);
    const antigravity = renderForTarget('antigravity', 'testsprite-verify', STUB_BODY);

    expect(claude.path).not.toBe(antigravity.path);
    // Body content should be identical
    expect(claude.content).toBe(antigravity.content);
  });
});

describe('renderForTarget("cursor")', () => {
  const result = renderForTarget('cursor', 'testsprite-verify', STUB_BODY);

  it('returns the correct path', () => {
    expect(result.path).toBe('.cursor/rules/testsprite-verify.mdc');
  });

  it('frontmatter has alwaysApply: false', () => {
    expect(result.content).toContain('alwaysApply: false');
  });

  it('frontmatter has description:', () => {
    expect(result.content).toContain(`description: ${SKILL_DESCRIPTION}`);
  });

  it('frontmatter does NOT have a globs: line', () => {
    // Extract frontmatter block
    const match = /^---\n([\s\S]*?)\n---/.exec(result.content);
    const fm = match?.[1] ?? '';
    expect(fm).not.toContain('globs:');
  });

  it('frontmatter does NOT have a name: line', () => {
    const match = /^---\n([\s\S]*?)\n---/.exec(result.content);
    const fm = match?.[1] ?? '';
    expect(fm).not.toContain('name:');
  });
});

describe('renderForTarget("cline")', () => {
  const result = renderForTarget('cline', 'testsprite-verify', STUB_BODY);

  it('returns the correct path', () => {
    expect(result.path).toBe('.clinerules/testsprite-verify.md');
  });

  it('has no --- frontmatter fence', () => {
    expect(result.content).not.toContain('---');
  });

  it('starts with the TestSprite Verification Loop H1 (the body H1)', () => {
    expect(result.content.trimStart().startsWith('# TestSprite Verification Loop')).toBe(true);
  });
});

describe('renderForTarget("windsurf")', () => {
  const result = renderForTarget('windsurf', 'testsprite-verify', STUB_BODY);

  it('returns the .windsurf/rules path', () => {
    expect(result.path).toBe('.windsurf/rules/testsprite-verify.md');
  });

  it('uses the Cascade frontmatter (trigger: model_decision + description)', () => {
    expect(result.content.startsWith('---\n')).toBe(true);
    expect(result.content).toContain('trigger: model_decision');
    expect(result.content).toContain(`description: ${SKILL_DESCRIPTION}`);
  });

  it('does NOT carry the Claude/Cursor frontmatter keys', () => {
    const match = /^---\n([\s\S]*?)\n---/.exec(result.content);
    const fm = match?.[1] ?? '';
    expect(fm).not.toContain('name:'); // claude key
    expect(fm).not.toContain('alwaysApply:'); // cursor .mdc key
  });
});

describe('windsurf renders within the rules-file budget', () => {
  // Regression: a `.windsurf/rules/*.md` file caps at ~12 K characters and
  // Cascade silently truncates beyond that. The full verify body (~22 KB) would
  // be cut in half, so windsurf renders the COMPACT body for verify (its trimmed
  // codex asset) and the full body for onboard (which already fits). Uses the
  // REAL bodies (no stub) so the size reflects what a user receives.
  for (const skill of DEFAULT_SKILLS) {
    it(`${skill} fits under 12 000 characters`, () => {
      const r = renderForTarget('windsurf', skill);
      expect(r.content.length).toBeLessThan(12_000);
    });
  }

  it('verify uses the compact body (smaller than the full claude render)', () => {
    const windsurf = renderForTarget('windsurf', 'testsprite-verify');
    const claude = renderForTarget('claude', 'testsprite-verify');
    expect(windsurf.content.length).toBeLessThan(claude.content.length);
    // The full-body-only intro line is absent from the compact body...
    expect(claude.content).toContain('The verification loop that flies');
    expect(windsurf.content).not.toContain('The verification loop that flies');
    // ...but the load-bearing command survives.
    expect(windsurf.content).toContain('testsprite test run');
  });
});

describe('renderForTarget("copilot")', () => {
  const result = renderForTarget('copilot', 'testsprite-verify', STUB_BODY);

  it('returns the .github/instructions path', () => {
    expect(result.path).toBe('.github/instructions/testsprite-verify.instructions.md');
  });

  it('uses the Copilot frontmatter (applyTo + description)', () => {
    expect(result.content.startsWith('---\n')).toBe(true);
    expect(result.content).toContain(`description: ${SKILL_DESCRIPTION}`);
    expect(result.content).toContain("applyTo: '**'");
  });

  it('does NOT carry the Claude/Cursor/Windsurf frontmatter keys', () => {
    const match = /^---\n([\s\S]*?)\n---/.exec(result.content);
    const fm = match?.[1] ?? '';
    expect(fm).not.toContain('name:'); // claude key
    expect(fm).not.toContain('alwaysApply:'); // cursor .mdc key
    expect(fm).not.toContain('trigger:'); // windsurf Cascade key
  });

  it('renders the compact verify body (applyTo:** is always-on, so keep it small)', () => {
    // Uses the REAL bodies (no stub): copilot always-injects, so like windsurf it
    // ships the trimmed verify body while keeping the load-bearing command.
    const copilot = renderForTarget('copilot', 'testsprite-verify');
    const claude = renderForTarget('claude', 'testsprite-verify');
    expect(copilot.content.length).toBeLessThan(claude.content.length);
    expect(copilot.content).not.toContain('The verification loop that flies');
    expect(copilot.content).toContain('testsprite test run');
  });
});

// ---------------------------------------------------------------------------
// Content integrity — load-bearing command strings must survive any body trim
// ---------------------------------------------------------------------------

describe('content integrity — own-file targets', () => {
  // Full-body own-file targets. Compact-body targets (windsurf, copilot) are
  // excluded — they render the trimmed verify body; see their dedicated tests.
  const ownFileTargets: Array<'claude' | 'cursor' | 'cline' | 'antigravity' | 'kiro'> = [
    'claude',
    'cursor',
    'cline',
    'antigravity',
    'kiro',
  ];

  // Use the real body for these checks, since we're guarding against trimming.
  for (const target of ownFileTargets) {
    describe(`target: ${target}`, () => {
      const result = renderForTarget(target, 'testsprite-verify');

      it('contains the TestSprite Verification Loop H1', () => {
        // The skill body opens with the renamed H1.
        expect(result.content).toContain('# TestSprite Verification Loop');
        expect(result.content).toContain('The verification loop that flies');
      });

      it('contains testsprite test run', () => {
        expect(result.content).toContain('testsprite test run');
      });

      it('contains --wait flag', () => {
        expect(result.content).toContain('--wait');
      });

      it('contains test artifact get', () => {
        expect(result.content).toContain('test artifact get');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// loadCodexSkillBody
// ---------------------------------------------------------------------------

describe('loadCodexSkillBody', () => {
  it('returns a non-empty string when using the injectable read stub', () => {
    const body = loadCodexSkillBody(() => '# stub codex body');
    expect(body).toBe('# stub codex body');
  });

  it('real loadCodexSkillBody() reads the actual asset and starts with the TestSprite Verification Loop H1', () => {
    const body = loadCodexSkillBody();
    expect(body.length).toBeGreaterThan(0);
    expect(body.trimStart().startsWith('# TestSprite Verification Loop')).toBe(true);
  });

  it('testsprite-verify.codex.md is ≤ 6144 bytes (6 KiB trim budget)', () => {
    const body = loadCodexSkillBody();
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(6144);
  });
});

// ---------------------------------------------------------------------------
// MANAGED_SECTION sentinels
// ---------------------------------------------------------------------------

describe('MANAGED_SECTION sentinels', () => {
  it('BEGIN sentinel is an HTML comment', () => {
    expect(MANAGED_SECTION_BEGIN.startsWith('<!--')).toBe(true);
    expect(MANAGED_SECTION_BEGIN.endsWith('-->')).toBe(true);
  });

  it('END sentinel is an HTML comment', () => {
    expect(MANAGED_SECTION_END.startsWith('<!--')).toBe(true);
    expect(MANAGED_SECTION_END.endsWith('-->')).toBe(true);
  });

  it('sentinels contain testsprite identity marker', () => {
    expect(MANAGED_SECTION_BEGIN.toLowerCase()).toContain('testsprite');
    expect(MANAGED_SECTION_END.toLowerCase()).toContain('testsprite');
  });
});

// ---------------------------------------------------------------------------
// content integrity — codex target
// ---------------------------------------------------------------------------

describe('content integrity — codex target (testsprite-verify.codex.md)', () => {
  it('contains testsprite test run (load-bearing command)', () => {
    const body = loadCodexSkillBody();
    expect(body).toContain('testsprite test run');
  });

  it('contains --wait flag (load-bearing command string)', () => {
    const body = loadCodexSkillBody();
    expect(body).toContain('--wait');
  });

  it('contains test artifact get (load-bearing command)', () => {
    const body = loadCodexSkillBody();
    expect(body).toContain('test artifact get');
  });

  it('renderForTarget("codex") path is AGENTS.md', () => {
    const STUB_CODEX_BODY =
      '# TestSprite Verification Loop\ntestsprite test run\n--wait\ntest artifact get\n';
    const result = renderForTarget('codex', 'testsprite-verify', STUB_CODEX_BODY);
    expect(result.path).toBe('AGENTS.md');
  });

  it('renderForTarget("codex") content is the body unwrapped (no frontmatter)', () => {
    const STUB_CODEX_BODY =
      '# TestSprite Verification Loop\ntestsprite test run\n--wait\ntest artifact get\n';
    const result = renderForTarget('codex', 'testsprite-verify', STUB_CODEX_BODY);
    // codex wrap is identity — no frontmatter fences
    expect(result.content).toBe(STUB_CODEX_BODY);
    expect(result.content).not.toContain('---');
  });

  it('renderForTarget("codex") without body arg uses codex asset (not full skill body)', () => {
    // The real codex asset is trimmed (no acronym line).
    const result = renderForTarget('codex', 'testsprite-verify');
    // Plain Markdown; no frontmatter fences from own-file wraps
    expect(result.content).not.toContain('name: testsprite-verify');
    expect(result.content).not.toContain('alwaysApply:');
  });
});

// ---------------------------------------------------------------------------
// SKILLS registry
// ---------------------------------------------------------------------------

describe('SKILLS registry', () => {
  it('has testsprite-verify key', () => {
    expect(SKILLS['testsprite-verify']).toBeDefined();
  });

  it('has testsprite-onboard key', () => {
    expect(SKILLS['testsprite-onboard']).toBeDefined();
  });

  it('testsprite-verify description is ≤ 1536 characters', () => {
    expect(SKILLS['testsprite-verify']!.description.length).toBeLessThanOrEqual(1536);
  });

  it('testsprite-onboard description is ≤ 1536 characters', () => {
    expect(SKILLS['testsprite-onboard']!.description.length).toBeLessThanOrEqual(1536);
  });

  it('testsprite-verify description is byte-identical to skill-template.md frontmatter description', () => {
    expect(templateDescription).toBeDefined();
    expect(SKILLS['testsprite-verify']!.description).toBe(templateDescription);
  });

  it('testsprite-onboard description is byte-identical to onboard-skill-template.md frontmatter description', () => {
    expect(onboardTemplateDescription).toBeDefined();
    expect(SKILLS['testsprite-onboard']!.description).toBe(onboardTemplateDescription);
  });

  it('testsprite-verify has bodyFile testsprite-verify.skill.md', () => {
    expect(SKILLS['testsprite-verify']!.bodyFile).toBe('testsprite-verify.skill.md');
  });

  it('testsprite-onboard has bodyFile testsprite-onboard.skill.md', () => {
    expect(SKILLS['testsprite-onboard']!.bodyFile).toBe('testsprite-onboard.skill.md');
  });

  it('testsprite-verify codex kind is full', () => {
    const codex = SKILLS['testsprite-verify']!.codex;
    expect(codex.kind).toBe('full');
  });

  it('testsprite-onboard codex kind is line', () => {
    const codex = SKILLS['testsprite-onboard']!.codex;
    expect(codex.kind).toBe('line');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SKILLS
// ---------------------------------------------------------------------------

describe('DEFAULT_SKILLS', () => {
  it('equals ["testsprite-verify", "testsprite-onboard"]', () => {
    expect(DEFAULT_SKILLS).toEqual(['testsprite-verify', 'testsprite-onboard']);
  });

  it('has exactly two entries', () => {
    expect(DEFAULT_SKILLS.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// pathFor
// ---------------------------------------------------------------------------

describe('pathFor', () => {
  it('claude + testsprite-verify', () => {
    expect(pathFor('claude', 'testsprite-verify')).toBe(
      '.claude/skills/testsprite-verify/SKILL.md',
    );
  });

  it('antigravity + testsprite-verify', () => {
    expect(pathFor('antigravity', 'testsprite-verify')).toBe(
      '.agents/skills/testsprite-verify/SKILL.md',
    );
  });

  it('cursor + testsprite-verify', () => {
    expect(pathFor('cursor', 'testsprite-verify')).toBe('.cursor/rules/testsprite-verify.mdc');
  });

  it('cline + testsprite-verify', () => {
    expect(pathFor('cline', 'testsprite-verify')).toBe('.clinerules/testsprite-verify.md');
  });

  it('codex + testsprite-verify', () => {
    expect(pathFor('codex', 'testsprite-verify')).toBe('AGENTS.md');
  });

  it('claude + testsprite-onboard', () => {
    expect(pathFor('claude', 'testsprite-onboard')).toBe(
      '.claude/skills/testsprite-onboard/SKILL.md',
    );
  });

  it('antigravity + testsprite-onboard', () => {
    expect(pathFor('antigravity', 'testsprite-onboard')).toBe(
      '.agents/skills/testsprite-onboard/SKILL.md',
    );
  });

  it('cursor + testsprite-onboard', () => {
    expect(pathFor('cursor', 'testsprite-onboard')).toBe('.cursor/rules/testsprite-onboard.mdc');
  });

  it('cline + testsprite-onboard', () => {
    expect(pathFor('cline', 'testsprite-onboard')).toBe('.clinerules/testsprite-onboard.md');
  });

  it('codex + testsprite-onboard is AGENTS.md (shared)', () => {
    expect(pathFor('codex', 'testsprite-onboard')).toBe('AGENTS.md');
  });

  it('TARGETS[t].path === pathFor(t, "testsprite-verify") for every target', () => {
    for (const [target] of Object.entries(TARGETS)) {
      expect(TARGETS[target as keyof typeof TARGETS].path).toBe(
        pathFor(target as Parameters<typeof pathFor>[0], 'testsprite-verify'),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// loadSkillBodyFor
// ---------------------------------------------------------------------------

describe('loadSkillBodyFor', () => {
  it('stub read returns the provided stub body for testsprite-verify', () => {
    const body = loadSkillBodyFor('testsprite-verify', () => STUB_BODY);
    expect(body).toBe(STUB_BODY);
  });

  it('stub read returns the provided stub body for testsprite-onboard', () => {
    const ONBOARD_STUB = '# TestSprite: onboard a repo with a seed test suite\nStub.';
    const body = loadSkillBodyFor('testsprite-onboard', () => ONBOARD_STUB);
    expect(body).toBe(ONBOARD_STUB);
  });

  it('real loadSkillBodyFor("testsprite-verify") starts with the verify H1', () => {
    const body = loadSkillBodyFor('testsprite-verify');
    expect(body.trimStart().startsWith('# TestSprite Verification Loop')).toBe(true);
  });

  it('real loadSkillBodyFor("testsprite-onboard") contains the onboard H1', () => {
    const body = loadSkillBodyFor('testsprite-onboard');
    expect(body).toContain('# TestSprite: onboard a repo with a seed test suite');
  });

  it('unknown skill throws', () => {
    expect(() => loadSkillBodyFor('testsprite-unknown')).toThrow('unknown skill');
  });
});

// ---------------------------------------------------------------------------
// codexContentFor
// ---------------------------------------------------------------------------

describe('codexContentFor', () => {
  it('testsprite-verify (full) contains "testsprite test run"', () => {
    const content = codexContentFor('testsprite-verify');
    expect(content).toContain('testsprite test run');
  });

  it('testsprite-verify (full) contains "--wait"', () => {
    const content = codexContentFor('testsprite-verify');
    expect(content).toContain('--wait');
  });

  it('testsprite-onboard (line) equals ONBOARD_CODEX_LINE', () => {
    const content = codexContentFor('testsprite-onboard');
    expect(content).toBe(ONBOARD_CODEX_LINE);
  });

  it('ONBOARD_CODEX_LINE starts with "**First-time setup:**"', () => {
    expect(ONBOARD_CODEX_LINE.startsWith('**First-time setup:**')).toBe(true);
  });

  it('unknown skill throws', () => {
    expect(() => codexContentFor('testsprite-unknown')).toThrow('unknown skill');
  });

  it('testsprite-verify with stub read returns stub value', () => {
    const content = codexContentFor('testsprite-verify', () => '# stub codex');
    expect(content).toBe('# stub codex');
  });
});

// ---------------------------------------------------------------------------
// buildCodexAggregate
// ---------------------------------------------------------------------------

describe('buildCodexAggregate', () => {
  it('single verify is byte-identical to loadCodexSkillBody().trimEnd()', () => {
    const aggregate = buildCodexAggregate(['testsprite-verify']);
    expect(aggregate).toBe(loadCodexSkillBody().trimEnd());
  });

  it('DEFAULT_SKILLS aggregate contains the verify H1', () => {
    const aggregate = buildCodexAggregate(DEFAULT_SKILLS);
    expect(aggregate).toContain('# TestSprite Verification Loop');
  });

  it('DEFAULT_SKILLS aggregate contains the onboard line', () => {
    const aggregate = buildCodexAggregate(DEFAULT_SKILLS);
    expect(aggregate).toContain('**First-time setup:**');
  });

  it('DEFAULT_SKILLS aggregate byte length is < 32768 (AGENTS.md budget)', () => {
    const aggregate = buildCodexAggregate(DEFAULT_SKILLS);
    expect(Buffer.byteLength(aggregate, 'utf8')).toBeLessThan(32768);
  });

  it('empty skills list returns empty string', () => {
    const aggregate = buildCodexAggregate([]);
    expect(aggregate).toBe('');
  });

  it('DEFAULT_SKILLS aggregate with stub read joins both contributions', () => {
    const stubRead = () => '# Verify stub';
    const aggregate = buildCodexAggregate(DEFAULT_SKILLS, stubRead);
    // verify contributes the stub read result, onboard contributes its inline line
    expect(aggregate).toContain('# Verify stub');
    expect(aggregate).toContain('**First-time setup:**');
  });
});

// ---------------------------------------------------------------------------
// renderForTarget — onboard skill
// ---------------------------------------------------------------------------

describe('renderForTarget for testsprite-onboard', () => {
  it('claude path is .claude/skills/testsprite-onboard/SKILL.md', () => {
    const result = renderForTarget('claude', 'testsprite-onboard');
    expect(result.path).toBe('.claude/skills/testsprite-onboard/SKILL.md');
  });

  it('claude frontmatter contains name: testsprite-onboard', () => {
    const result = renderForTarget('claude', 'testsprite-onboard');
    expect(result.content).toContain('name: testsprite-onboard');
  });

  it('claude body contains onboard H1', () => {
    const result = renderForTarget('claude', 'testsprite-onboard');
    expect(result.content).toContain('# TestSprite: onboard a repo with a seed test suite');
  });

  it('cursor onboard path is .cursor/rules/testsprite-onboard.mdc', () => {
    const result = renderForTarget('cursor', 'testsprite-onboard');
    expect(result.path).toBe('.cursor/rules/testsprite-onboard.mdc');
  });

  it('cursor onboard frontmatter has alwaysApply: false', () => {
    const result = renderForTarget('cursor', 'testsprite-onboard');
    expect(result.content).toContain('alwaysApply: false');
  });

  it('cline onboard path is .clinerules/testsprite-onboard.md', () => {
    const result = renderForTarget('cline', 'testsprite-onboard');
    expect(result.path).toBe('.clinerules/testsprite-onboard.md');
  });

  it('cline onboard has no frontmatter fence', () => {
    const result = renderForTarget('cline', 'testsprite-onboard');
    expect(result.content).not.toContain('---');
  });

  it('codex onboard renders the unwrapped ONBOARD_CODEX_LINE', () => {
    const result = renderForTarget('codex', 'testsprite-onboard');
    expect(result.content).toBe(ONBOARD_CODEX_LINE);
    expect(result.content).not.toContain('---');
  });

  it('codex onboard path is AGENTS.md', () => {
    const result = renderForTarget('codex', 'testsprite-onboard');
    expect(result.path).toBe('AGENTS.md');
  });

  it('unknown skill throws for renderForTarget', () => {
    expect(() => renderForTarget('claude', 'testsprite-unknown')).toThrow('unknown skill');
  });
});

// ---------------------------------------------------------------------------
// Install marker (issue #123): format, parsing, and render placement
// ---------------------------------------------------------------------------

describe('buildSkillMarker / parseSkillMarker / bodyHash12', () => {
  it('marker line is an HTML comment carrying name, vVERSION, and a 12-hex hash', () => {
    const marker = buildSkillMarker('testsprite-verify', STUB_BODY);
    expect(marker).toBe(
      `<!-- testsprite-skill: testsprite-verify v${VERSION} sha256:${bodyHash12(STUB_BODY)} -->`,
    );
    expect(marker).toMatch(
      /^<!-- testsprite-skill: testsprite-verify v\S+ sha256:[0-9a-f]{12} -->$/,
    );
  });

  it('bodyHash12 equals the first 12 hex chars of the body SHA-256', () => {
    const fullHex = createHash('sha256').update(STUB_BODY, 'utf8').digest('hex');
    expect(bodyHash12(STUB_BODY)).toBe(fullHex.slice(0, 12));
  });

  it('parseSkillMarker round-trips a built marker embedded in surrounding content', () => {
    const marker = buildSkillMarker('testsprite-verify', STUB_BODY);
    const parsed = parseSkillMarker(`# heading\n${marker}\nbody text\n`);
    expect(parsed).not.toBeNull();
    expect(parsed?.skill).toBe('testsprite-verify');
    expect(parsed?.version).toBe(VERSION);
    expect(parsed?.hash12).toBe(bodyHash12(STUB_BODY));
    expect(parsed?.line).toBe(marker);
  });

  it('parseSkillMarker strips a trailing CR so CRLF checkouts parse identically', () => {
    const marker = buildSkillMarker('testsprite-verify', STUB_BODY);
    const parsed = parseSkillMarker(`${marker}\r\nrest\r\n`);
    expect(parsed?.line).toBe(marker);
  });

  it('parseSkillMarker returns null when no marker line is present', () => {
    expect(parseSkillMarker('# Just a heading\n\nProse without any marker.\n')).toBeNull();
  });

  it('parseSkillMarker ignores the managed-section sentinels (also HTML comments)', () => {
    expect(parseSkillMarker(`${MANAGED_SECTION_BEGIN}\nbody\n${MANAGED_SECTION_END}\n`)).toBeNull();
  });
});

describe('render marker placement (own-file targets)', () => {
  it('claude render carries the marker on the line right after the closing frontmatter fence', () => {
    const { content } = renderForTarget('claude', 'testsprite-verify', STUB_BODY);
    const closingFence = '\n---\n';
    const fenceEnd = content.indexOf(closingFence) + closingFence.length;
    expect(content.slice(fenceEnd).startsWith('<!-- testsprite-skill: testsprite-verify ')).toBe(
      true,
    );
  });

  it('cline render appends the marker as the LAST line so the body H1 stays first', () => {
    const { content } = renderForTarget('cline', 'testsprite-verify', STUB_BODY);
    expect(content.trimStart().startsWith('# TestSprite Verification Loop')).toBe(true);
    const lines = content.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe(buildSkillMarker('testsprite-verify', STUB_BODY));
  });

  it('marker hash covers the canonical body only: same body renders the same hash on every target', () => {
    const claudeMarker = parseSkillMarker(
      renderForTarget('claude', 'testsprite-verify', STUB_BODY).content,
    );
    const cursorMarker = parseSkillMarker(
      renderForTarget('cursor', 'testsprite-verify', STUB_BODY).content,
    );
    expect(claudeMarker?.hash12).toBe(bodyHash12(STUB_BODY));
    expect(cursorMarker?.hash12).toBe(bodyHash12(STUB_BODY));
  });

  it('renderForTarget("codex") stays marker-free (the install writes the section marker)', () => {
    const result = renderForTarget('codex', 'testsprite-verify', '# codex stub\n');
    expect(result.content).toBe('# codex stub\n');
    expect(parseSkillMarker(result.content)).toBeNull();
  });

  it('renderOwnFileWithMarker splices an arbitrary marker line into the canonical render', () => {
    const foreignMarker = '<!-- testsprite-skill: testsprite-verify v0.0.1 sha256:0123456789ab -->';
    const withForeign = renderOwnFileWithMarker(
      'claude',
      'testsprite-verify',
      foreignMarker,
      STUB_BODY,
    );
    expect(withForeign).toContain(foreignMarker);
    // Marker line aside, the bytes match the canonical render exactly.
    const canonical = renderForTarget('claude', 'testsprite-verify', STUB_BODY).content;
    const currentMarker = buildSkillMarker('testsprite-verify', STUB_BODY);
    expect(withForeign.replace(foreignMarker, currentMarker)).toBe(canonical);
  });

  it('renderOwnFileWithMarker rejects the managed-section target', () => {
    expect(() => renderOwnFileWithMarker('codex', 'testsprite-verify', 'marker', 'body')).toThrow(
      'own-file',
    );
  });

  it('renderOwnFileWithMarker throws on an unknown skill', () => {
    expect(() => renderOwnFileWithMarker('claude', 'testsprite-unknown', 'marker')).toThrow(
      'unknown skill',
    );
  });
});
