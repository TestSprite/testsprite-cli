import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../version.js';
import {
  type AgentTarget,
  CANONICAL_SKILLS_DIR,
  DEFAULT_SKILLS,
  SKILLS,
  TARGETS,
  TARGET_ALIASES,
  acceptedTargetTokens,
  bodyHash12,
  buildSkillMarker,
  canonicalSkillDir,
  canonicalSkillFile,
  loadSkill,
  loadSkillFull,
  parseSkillFrontmatter,
  parseSkillMarker,
  pathFor,
  renderCanonical,
  renderCanonicalWithMarker,
  resolveTarget,
  targetLandingDir,
} from './agent-targets.js';

// A stub SKILL.md (frontmatter + body) used to keep render/marker tests off disk.
const STUB_SKILL_MD = `---\nname: testsprite-verify\ndescription: stub description\n---\n\n# TestSprite Verification Loop\n\nStub body.\n`;

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('TARGETS registry', () => {
  it('canonical directory is .agents/skills', () => {
    expect(CANONICAL_SKILLS_DIR).toBe('.agents/skills');
  });

  // Exact key set — any add/remove/reorder surfaces here for review.
  it('exposes the full standard agent set', () => {
    expect(Object.keys(TARGETS)).toEqual([
      'adal',
      'aider-desk',
      'amp',
      'antigravity',
      'antigravity-cli',
      'astrbot',
      'augment',
      'autohand-code',
      'bob',
      'claude-code',
      'cline',
      'codearts-agent',
      'codebuddy',
      'codebuddy-cli',
      'codebuddy-cn',
      'codebuddy-cn-cli',
      'codestudio',
      'codex',
      'command-code',
      'continue',
      'cortex',
      'crush',
      'cursor',
      'devin',
      'devin-cloud',
      'devin-desktop',
      'droid',
      'eve',
      'firebender',
      'forgecode',
      'github-copilot',
      'goose',
      'hermes-agent',
      'junie',
      'kilo',
      'kimi-code-cli',
      'kiro',
      'kiro-cli',
      'kode',
      'mcpjam',
      'mistral-vibe',
      'mux',
      'neovate',
      'ona',
      'opencode',
      'openclaw',
      'openhands',
      'pi',
      'pochi',
      'promptscript',
      'qoder',
      'qoder-cli',
      'qoder-cn',
      'qoder-cn-cli',
      'qwen-code',
      'reasonix',
      'replit',
      'rovodev',
      'tabnine-cli',
      'trae',
      'trae-cn',
      'trae-cn-cli',
      'vtcode',
      'warp',
      'zed',
      'zencoder',
    ]);
  });

  it('every entry is internally consistent (checked for ALL targets, not spot-checked)', () => {
    for (const [id, spec] of Object.entries(TARGETS)) {
      expect(spec.displayName.length, `${id} displayName`).toBeGreaterThan(0);
      // skillsDir is the canonical shared dir or an agent-local /skills path.
      expect(
        spec.skillsDir === CANONICAL_SKILLS_DIR ||
          spec.skillsDir === 'skills' ||
          spec.skillsDir.endsWith('/skills'),
        `${id} skillsDir "${spec.skillsDir}"`,
      ).toBe(true);
      // universal === "reads the canonical dir directly".
      expect(spec.universal, `${id} universal`).toBe(spec.skillsDir === CANONICAL_SKILLS_DIR);
    }
  });
});

// ---------------------------------------------------------------------------
// Aliases + resolveTarget
// ---------------------------------------------------------------------------

describe('TARGET_ALIASES + resolveTarget', () => {
  it('every alias maps to a real canonical id', () => {
    for (const [alias, id] of Object.entries(TARGET_ALIASES)) {
      expect(TARGETS[id], `alias ${alias} → ${id}`).toBeDefined();
    }
  });

  it('no alias equals its canonical id (an identical alias would be pointless)', () => {
    for (const [alias, id] of Object.entries(TARGET_ALIASES)) {
      expect(alias, `${alias} === ${id}`).not.toBe(id);
    }
  });

  it('resolveTarget returns every canonical id as-is', () => {
    for (const id of Object.keys(TARGETS)) {
      expect(resolveTarget(id), id).toBe(id);
    }
  });

  it('resolveTarget resolves every alias to its mapped id', () => {
    for (const [alias, id] of Object.entries(TARGET_ALIASES)) {
      expect(resolveTarget(alias), alias).toBe(id);
    }
  });

  it('resolveTarget rejects an unknown token', () => {
    expect(resolveTarget('definitely-not-an-agent')).toBeNull();
  });

  it('acceptedTargetTokens is exactly the ids plus the aliases', () => {
    expect(new Set(acceptedTargetTokens())).toEqual(
      new Set([...Object.keys(TARGETS), ...Object.keys(TARGET_ALIASES)]),
    );
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('path helpers', () => {
  it('canonicalSkillDir / canonicalSkillFile', () => {
    expect(canonicalSkillDir('testsprite-verify')).toBe('.agents/skills/testsprite-verify');
    expect(canonicalSkillFile('testsprite-verify')).toBe(
      '.agents/skills/testsprite-verify/SKILL.md',
    );
  });

  it('pathFor / targetLandingDir reach SKILL.md for every target', () => {
    for (const id of Object.keys(TARGETS) as AgentTarget[]) {
      const spec = TARGETS[id]!;
      const landing = targetLandingDir(id, 'testsprite-verify');
      expect(pathFor(id, 'testsprite-verify'), id).toBe(`${landing}/SKILL.md`);
      expect(landing, id).toBe(
        spec.universal ? '.agents/skills/testsprite-verify' : `${spec.skillsDir}/testsprite-verify`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SKILLS registry — metadata lives in the SKILL.md frontmatter
// ---------------------------------------------------------------------------

describe('SKILLS registry', () => {
  it('ships exactly verify and onboard, in install order', () => {
    expect(Object.keys(SKILLS)).toEqual(['testsprite-verify', 'testsprite-onboard']);
    expect([...DEFAULT_SKILLS]).toEqual(['testsprite-verify', 'testsprite-onboard']);
  });

  it('every entry points at its <id>.skill.md asset', () => {
    for (const [id, asset] of Object.entries(SKILLS)) {
      expect(asset.file, id).toBe(`${id}.skill.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parsing + loadSkill
// ---------------------------------------------------------------------------

describe('parseSkillFrontmatter', () => {
  it('extracts name + description + body', () => {
    const parsed = parseSkillFrontmatter(STUB_SKILL_MD);
    expect(parsed.name).toBe('testsprite-verify');
    expect(parsed.description).toBe('stub description');
    expect(parsed.body.trimStart().startsWith('# TestSprite Verification Loop')).toBe(true);
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parseSkillFrontmatter('no frontmatter here')).toThrow(/missing frontmatter/);
  });

  it('throws when name/description is missing', () => {
    expect(() => parseSkillFrontmatter('---\nname: only-name\n---\nbody')).toThrow(
      /missing required name\/description/,
    );
  });
});

describe('loadSkill', () => {
  it('parses every shipped skill consistently', () => {
    for (const id of Object.keys(SKILLS)) {
      const skill = loadSkill(id);
      expect(skill.name, id).toBe(id);
      expect(skill.description.length, `${id} description`).toBeGreaterThan(0);
      expect(skill.description.length, `${id} description overlong`).toBeLessThanOrEqual(1536);
      expect(skill.full.startsWith(`---\nname: ${id}\n`), id).toBe(true);
      expect(skill.body.length, `${id} body`).toBeGreaterThan(0);
      expect(skill.body.startsWith('---'), `${id} body leaks frontmatter`).toBe(false);
      expect(skill.full.endsWith(skill.body), `${id} full/body split`).toBe(true);
    }
  });

  it('verify skill body opens with its title', () => {
    expect(
      loadSkill('testsprite-verify').body.trimStart().startsWith('# TestSprite Verification Loop'),
    ).toBe(true);
  });

  it('throws on an unknown skill', () => {
    expect(() => loadSkill('nope')).toThrow(/unknown skill/);
  });

  it('throws when the registry id does not match the frontmatter name', () => {
    const mismatched = STUB_SKILL_MD.replace('name: testsprite-verify', 'name: other-name');
    expect(() => loadSkill('testsprite-verify', () => mismatched)).toThrow(/id mismatch/);
  });
});

describe('loadSkillFull', () => {
  it('equals loadSkill(id).full for every skill', () => {
    for (const id of Object.keys(SKILLS)) {
      expect(loadSkillFull(id), id).toBe(loadSkill(id).full);
    }
  });
});

// ---------------------------------------------------------------------------
// renderCanonical
// ---------------------------------------------------------------------------

describe('renderCanonical', () => {
  const rendered = renderCanonical('testsprite-verify', () => STUB_SKILL_MD);

  it('preserves the asset frontmatter (name + description)', () => {
    expect(rendered.startsWith('---\nname: testsprite-verify\n')).toBe(true);
    expect(rendered).toContain('description: stub description');
  });

  it('injects the testsprite-skill marker right after the closing fence', () => {
    expect(rendered).toContain(buildSkillMarker('testsprite-verify', STUB_SKILL_MD));
    // marker sits between the closing --- and the body H1
    const afterFence = rendered.slice(rendered.indexOf('\n---\n') + 5);
    expect(afterFence.startsWith('<!-- testsprite-skill:')).toBe(true);
  });

  it('keeps the body intact after the marker', () => {
    expect(rendered).toContain('# TestSprite Verification Loop');
  });

  it('ends with a trailing newline', () => {
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('renderCanonicalWithMarker re-renders byte-identically with the same marker', () => {
    const marker = buildSkillMarker('testsprite-verify', STUB_SKILL_MD);
    const a = renderCanonicalWithMarker('testsprite-verify', marker, () => STUB_SKILL_MD);
    const b = renderCanonicalWithMarker('testsprite-verify', marker, () => STUB_SKILL_MD);
    expect(a).toBe(b);
    expect(a).toBe(rendered); // same as a fresh canonical render
  });
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

describe('skill markers', () => {
  it('bodyHash12 is the first 12 hex chars of sha256(content)', () => {
    const expected = createHash('sha256').update(STUB_SKILL_MD, 'utf8').digest('hex').slice(0, 12);
    expect(bodyHash12(STUB_SKILL_MD)).toBe(expected);
  });

  it('buildSkillMarker embeds name, version, and hash', () => {
    const marker = buildSkillMarker('testsprite-verify', STUB_SKILL_MD);
    expect(marker).toBe(
      `<!-- testsprite-skill: testsprite-verify v${VERSION} sha256:${bodyHash12(STUB_SKILL_MD)} -->`,
    );
  });

  it('parseSkillMarker round-trips a built marker', () => {
    const marker = buildSkillMarker('testsprite-onboard', STUB_SKILL_MD);
    const parsed = parseSkillMarker(marker);
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBe('testsprite-onboard');
    expect(parsed!.version).toBe(VERSION);
    expect(parsed!.hash12).toBe(bodyHash12(STUB_SKILL_MD));
    expect(parsed!.line).toBe(marker);
  });

  it('parseSkillMarker returns null when no marker is present', () => {
    expect(parseSkillMarker('just prose\nno marker here')).toBeNull();
  });

  it('parseSkillMarker finds the marker mid-file and strips trailing CR', () => {
    const marker = buildSkillMarker('testsprite-verify', STUB_SKILL_MD);
    const content = `# Title\n\n${marker}\r\nbody`;
    expect(parseSkillMarker(content)!.skill).toBe('testsprite-verify');
  });
});
