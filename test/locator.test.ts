import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { locateCopilotDataPaths } from '../src/core/locator';

describe('locateCopilotDataPaths', () => {
  const roots: string[] = [];
  const originalAppData = process.env.APPDATA;

  afterEach(async () => {
    process.env.APPDATA = originalAppData;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('includes VS Code global and workspace storage roots', async () => {
    const appData = await mkdtemp(join(tmpdir(), 'copilot-usage-appdata-'));
    roots.push(appData);
    process.env.APPDATA = appData;

    const globalStorage = join(appData, 'Code', 'User', 'globalStorage');
    const workspaceStorage = join(appData, 'Code', 'User', 'workspaceStorage');
    await mkdir(globalStorage, { recursive: true });
    await mkdir(workspaceStorage, { recursive: true });

    await expect(locateCopilotDataPaths('')).resolves.toEqual([globalStorage, workspaceStorage]);
  });
});
