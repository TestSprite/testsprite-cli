/**
 * The API endpoint override is for TestSprite's own use: the flag, the
 * environment variable and the credentials-file key keep working, and no text
 * a user reads names them. This suite reads what ships: the built binary's
 * help, completion scripts and error for a near-miss option, the strings in
 * the built code, and the documents and skills in the package and the repo.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST = join(REPO_ROOT, 'dist');
const BIN_PATH = join(DIST, 'index.js');

/** The three spellings of the override; `api_url` only as a whole word. */
const OVERRIDE_NAME = /endpoint-url|TESTSPRITE_API_URL|(?<![A-Za-z0-9_])api_url(?![A-Za-z0-9_])/;

function cli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TESTSPRITE_NO_TELEMETRY: '1' },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** The lines of `text` that name the override, for a readable failure. */
function mentions(text: string): string[] {
  return text.split('\n').filter(line => OVERRIDE_NAME.test(line));
}

/** Subcommand names from the `Commands:` block of one help page. */
function subcommandsIn(help: string): string[] {
  const lines = help.split('\n');
  const start = lines.indexOf('Commands:');
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const entry = /^ {2}(\S+)/.exec(line);
    if (entry) names.push(entry[1]!.split('|')[0]!);
  }
  return names.filter(name => name !== 'help');
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('the API endpoint override is not shown to users', () => {
  beforeAll(() => {
    assertFreshBuild(REPO_ROOT, BIN_PATH);
  });

  it('no help page names it, at any depth of the command tree', () => {
    const found: string[] = [];
    let pages = 0;
    const visit = (path: string[]): void => {
      const page = cli([...path, '--help']);
      const help = page.stdout;
      // A page that failed to render would otherwise read as a clean one.
      expect(page.status, `${path.join(' ')} --help`).toBe(0);
      expect(help, `${path.join(' ')} --help`).toContain('Usage: testsprite');
      pages++;
      for (const line of mentions(help)) found.push(`${path.join(' ') || '(root)'}: ${line}`);
      for (const name of subcommandsIn(help)) visit([...path, name]);
    };
    visit([]);
    // The walk reached the tree: a parser that found no `Commands:` block
    // would read one page and pass.
    expect(pages).toBeGreaterThan(40);
    expect(found).toEqual([]);
  }, 120_000);

  it.each(['bash', 'zsh', 'fish'])('the %s completion script does not offer it', shell => {
    const script = cli(['completion', shell]).stdout;
    expect(script).toContain('testsprite');
    expect(mentions(script)).toEqual([]);
  });

  it('a near-miss option is not corrected to it', () => {
    const { stdout, stderr } = cli(['--endpoint-ur', 'https://api.example.com', 'project', 'list']);
    expect(stderr).toContain("unknown option '--endpoint-ur'");
    // What the user typed is echoed; nothing else on any line may name the flag.
    expect(mentions((stdout + stderr).split("'--endpoint-ur'").join(''))).toEqual([]);
  });

  it('still accepts the flag', () => {
    const { stdout } = cli([
      '--endpoint-url',
      'https://api.example.com',
      '--dry-run',
      '--output',
      'json',
      'project',
      'list',
    ]);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('the documents and the shipped skills do not name it', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    // Everything the package ships besides the compiled code, plus the
    // documents a user reads in the repository.
    const shipped = pkg.files
      .filter(entry => !entry.startsWith('!') && entry !== 'dist')
      .flatMap(entry => filesUnder(join(REPO_ROOT, entry)));
    const documents = ['README.md', 'DOCUMENTATION.md', 'CHANGELOG.md'].map(name =>
      join(REPO_ROOT, name),
    );
    expect(shipped.length).toBeGreaterThan(0);
    const found = [...shipped, ...documents].flatMap(file =>
      mentions(readFileSync(file, 'utf8')).map(line => `${relative(REPO_ROOT, file)}: ${line}`),
    );
    expect(found).toEqual([]);
  });

  it('no message in the built code names it, outside the paths only an override reaches', () => {
    // A line of built code names the override when it spells the flag, or the
    // variable or the file key other than as a property read (`env.X`).
    const NAMED_IN_CODE = /--endpoint-url|(?<!\.)TESTSPRITE_API_URL|api_url/;
    // Each of these is reached only once an override is already set, or is
    // the definition itself.
    const ALLOWED: Record<string, string[]> = {
      'index.js': ["new Option('--endpoint-url <url>'"],
      'commands/ci.js': [
        // `ci init` pins a non-default endpoint into the workflow it writes…
        'TESTSPRITE_API_URL: "${input.endpointUrl}"',
        // …and warns when a hosted runner cannot reach that endpoint.
        'pass --endpoint-url <public-url>',
      ],
      // Printed when the existing profile already carries an override.
      'commands/auth.js': ['Inheriting api_url from existing profile'],
      // The credentials file's key, mapped to and from the field name.
      'lib/credentials.js': ["api_url: 'apiUrl'", "apiUrl: 'api_url'"],
    };
    const found: string[] = [];
    for (const file of filesUnder(DIST).filter(file => file.endsWith('.js'))) {
      const name = relative(DIST, file).split('\\').join('/');
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
        if (!NAMED_IN_CODE.test(code)) continue;
        if ((ALLOWED[name] ?? []).some(snippet => code.includes(snippet))) continue;
        found.push(`${name}: ${code}`);
      }
    }
    expect(found).toEqual([]);
  });
});
