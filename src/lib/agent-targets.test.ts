import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  TARGETS,
  loadCodexSkillBody,
  loadSkillBody,
  renderForTarget,
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
  it('has all six required keys', () => {
    const keys = Object.keys(TARGETS).sort();
    expect(keys).toEqual(['antigravity', 'claude', 'cline', 'codex', 'cursor', 'gemini']);
  });

  it('claude is GA', () => {
    expect(TARGETS.claude.status).toBe('ga');
  });

  it('cursor, cline, antigravity, codex, and gemini are experimental', () => {
    expect(TARGETS.cursor.status).toBe('experimental');
    expect(TARGETS.cline.status).toBe('experimental');
    expect(TARGETS.antigravity.status).toBe('experimental');
    expect(TARGETS.codex.status).toBe('experimental');
    expect(TARGETS.gemini.status).toBe('experimental');
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
  });

  it('codex and gemini targets have mode managed-section', () => {
    expect(TARGETS.codex.mode).toBe('managed-section');
    expect(TARGETS.gemini.mode).toBe('managed-section');
  });

  it('codex target path is AGENTS.md', () => {
    expect(TARGETS.codex.path).toBe('AGENTS.md');
  });

  it('gemini target path is GEMINI.md', () => {
    expect(TARGETS.gemini.path).toBe('GEMINI.md');
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
  const result = renderForTarget('claude', STUB_BODY);

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
  const result = renderForTarget('antigravity', STUB_BODY);

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

describe('renderForTarget("claude") vs renderForTarget("antigravity")', () => {
  it('produce the same frontmatter lines (name + description)', () => {
    const claude = renderForTarget('claude', STUB_BODY);
    const antigravity = renderForTarget('antigravity', STUB_BODY);

    // Extract the frontmatter block from each
    const extractFrontmatter = (content: string): string => {
      const match = /^---\n([\s\S]*?)\n---/.exec(content);
      return match?.[1] ?? '';
    };

    expect(extractFrontmatter(claude.content)).toBe(extractFrontmatter(antigravity.content));
  });

  it('differ only in their landing path', () => {
    const claude = renderForTarget('claude', STUB_BODY);
    const antigravity = renderForTarget('antigravity', STUB_BODY);

    expect(claude.path).not.toBe(antigravity.path);
    // Body content should be identical
    expect(claude.content).toBe(antigravity.content);
  });
});

describe('renderForTarget("cursor")', () => {
  const result = renderForTarget('cursor', STUB_BODY);

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
  const result = renderForTarget('cline', STUB_BODY);

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

// ---------------------------------------------------------------------------
// Content integrity — load-bearing command strings must survive any body trim
// ---------------------------------------------------------------------------

describe('content integrity — own-file targets', () => {
  const ownFileTargets: Array<'claude' | 'cursor' | 'cline' | 'antigravity'> = [
    'claude',
    'cursor',
    'cline',
    'antigravity',
  ];

  // Use the real body for these checks, since we're guarding against trimming.
  for (const target of ownFileTargets) {
    describe(`target: ${target}`, () => {
      const result = renderForTarget(target);

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
    const result = renderForTarget('codex', STUB_CODEX_BODY);
    expect(result.path).toBe('AGENTS.md');
  });

  it('renderForTarget("codex") content is the body unwrapped (no frontmatter)', () => {
    const STUB_CODEX_BODY =
      '# TestSprite Verification Loop\ntestsprite test run\n--wait\ntest artifact get\n';
    const result = renderForTarget('codex', STUB_CODEX_BODY);
    // codex wrap is identity — no frontmatter fences
    expect(result.content).toBe(STUB_CODEX_BODY);
    expect(result.content).not.toContain('---');
  });

  it('renderForTarget("codex") without body arg uses codex asset (not full skill body)', () => {
    // The real codex asset is trimmed (no acronym line).
    const result = renderForTarget('codex');
    // Plain Markdown; no frontmatter fences from own-file wraps
    expect(result.content).not.toContain('name: testsprite-verify');
    expect(result.content).not.toContain('alwaysApply:');
  });
});

// ---------------------------------------------------------------------------
// content integrity — gemini target
// ---------------------------------------------------------------------------

describe('content integrity — gemini target (GEMINI.md managed-section body)', () => {
  it('renderForTarget("gemini") path is GEMINI.md', () => {
    const STUB_GEMINI_BODY =
      '# TestSprite Verification Loop\ntestsprite test run\n--wait\ntest artifact get\n';
    const result = renderForTarget('gemini', STUB_GEMINI_BODY);
    expect(result.path).toBe('GEMINI.md');
  });

  it('renderForTarget("gemini") content is the body unwrapped (no frontmatter)', () => {
    const STUB_GEMINI_BODY =
      '# TestSprite Verification Loop\ntestsprite test run\n--wait\ntest artifact get\n';
    const result = renderForTarget('gemini', STUB_GEMINI_BODY);
    expect(result.content).toBe(STUB_GEMINI_BODY);
    expect(result.content).not.toContain('---');
  });

  it('renderForTarget("gemini") without body arg uses the managed-section asset', () => {
    const result = renderForTarget('gemini');
    expect(result.content).toContain('testsprite test run');
    expect(result.content).not.toContain('name: testsprite-verify');
    expect(result.content).not.toContain('alwaysApply:');
  });
});
