import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The viewer shares a few vocabularies with the server instead of keeping its
 * own copy: the supported locales, the docs API error codes, the import steps.
 * Those modules live outside `web/`, so the container's web-builder stage has
 * to copy each one explicitly — it builds from `web/` alone and nothing else.
 *
 * Nothing in the normal loop notices when that drifts. `pnpm build:web` on a
 * developer's machine has the whole repository on disk and resolves the import
 * fine; the build only fails inside `podman build`, at deploy time, which is
 * the worst moment to find out. So compare the two lists here.
 */

const ROOT = path.resolve(__dirname, '..');
const WEB_SRC = path.join(ROOT, 'web', 'src');
const CONTAINERFILE = path.join(ROOT, 'deployment', 'Containerfile');

/** Every file under `web/src`, which is the only place the viewer's code lives. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Module specifiers that climb out of `web/`, resolved to repository-relative
 * paths with a `.ts` extension — the form a COPY line names.
 */
function crossBoundaryImports(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(WEB_SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'((?:\.\.\/)+[^']+)'/g)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      if (resolved.startsWith(`${WEB_SRC}${path.sep}`)) continue; // still inside the app
      found.add(`${path.relative(ROOT, resolved)}.ts`);
    }
  }
  return found;
}

/** The files the web-builder stage copies in, one COPY line each. */
function containerfileWebStageCopies(): Set<string> {
  const containerfile = fs.readFileSync(CONTAINERFILE, 'utf8');
  // Only the first stage builds the viewer; later stages copy the built output.
  const webStage = containerfile.split(/^FROM .* AS deps$/m)[0];
  const copied = new Set<string>();
  for (const match of webStage.matchAll(/^COPY\s+(\S+)\s+\.\/(\S+)$/gm)) {
    if (match[1].endsWith('.ts')) copied.add(match[1]);
  }
  return copied;
}

describe('modules the viewer shares with the server', () => {
  it('are all copied into the container image that builds the viewer', () => {
    const imported = crossBoundaryImports();
    const copied = containerfileWebStageCopies();

    // Sorted arrays rather than sets: a failure then names the file.
    const missing = [...imported].filter((file) => !copied.has(file)).sort();
    expect(missing).toEqual([]);
  });

  it('does not copy files the viewer stopped importing', () => {
    const imported = crossBoundaryImports();
    const copied = containerfileWebStageCopies();

    const unused = [...copied].filter((file) => !imported.has(file)).sort();
    expect(unused).toEqual([]);
  });

  it('are import-free, so copying the file alone is enough', () => {
    for (const file of crossBoundaryImports()) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const imports = source.match(/^\s*import\s/gm) ?? [];
      // A shared module that grows an import would need its dependency copied
      // too — at which point it should stop being shared this way.
      expect({ file, imports: imports.length }).toEqual({ file, imports: 0 });
    }
  });

  it('finds the imports it is meant to be checking', () => {
    // Guards the regex above: if it silently matched nothing, the other cases
    // would pass while checking nothing at all.
    expect(crossBoundaryImports().size).toBeGreaterThan(0);
  });
});
