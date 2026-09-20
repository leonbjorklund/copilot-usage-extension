import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: vi.fn(),
}));

import { locateCopilotDataPaths } from '../src/core/locator';

describe('locateCopilotDataPaths', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it.each(['Code', 'Code - Insiders'])('includes %s storage roots across platforms', async (editor) => {
    const appData = await mkdtemp(join(tmpdir(), 'copilot-usage-appdata-'));
    roots.push(appData);
    vi.stubEnv('APPDATA', appData);
    const home = join(appData, 'home');
    vi.mocked(homedir).mockReturnValue(home);

    const storageRoots = [appData, join(home, '.config'), join(home, 'Library', 'Application Support')]
      .flatMap(base => ['globalStorage', 'workspaceStorage'].map(storage => join(base, editor, 'User', storage)));
    await Promise.all(storageRoots.map(root => mkdir(root, { recursive: true })));

    await expect(locateCopilotDataPaths('')).resolves.toEqual(storageRoots);
  });
});
