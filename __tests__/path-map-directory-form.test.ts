import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DATA = path.join(os.tmpdir(), 'choir-path-map-test');
process.env.CHOIR_DATA_DIR = DATA;

import { PathMapService } from '../services/workspace/path-map-service';

const ws = 'T-path-map';
const stateDir = path.join(DATA, 'workspaces', ws, 'state');

beforeAll(async () => {
  fs.rmSync(path.join(DATA, 'workspaces', ws), { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  await PathMapService.getInstance().save(ws, ['06_Conferences.md', 'docs/Getting Started.md']);
  PathMapService.getInstance().invalidate(ws);
});

describe('PathMapService reverse lookup', () => {
  const svc = () => PathMapService.getInstance();

  it('resolves the file form qmd writes for a top-level document', () => {
    expect(svc().getOriginalPath(ws, '06-conferences.md')).toBe('06_Conferences.md');
  });

  it('resolves the directory form a section path arrives in', () => {
    // Section files live at `<original path>/<index>.md`, and qmd only keeps an
    // extension on the last segment — so the citation URL used to be built from
    // the raw `06-conferences-md` and 404'd in the docs viewer.
    expect(svc().getOriginalPath(ws, '06-conferences-md')).toBe('06_Conferences.md');
  });

  it('resolves the directory form for a nested document', () => {
    expect(svc().getOriginalPath(ws, 'docs/getting-started-md')).toBe('docs/Getting Started.md');
  });

  it('passes an unknown path through unchanged', () => {
    expect(svc().getOriginalPath(ws, 'nope-md')).toBe('nope-md');
  });
});
