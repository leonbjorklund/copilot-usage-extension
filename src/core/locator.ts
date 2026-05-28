import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function locateCopilotDataPaths(extraPath: string): Promise<string[]> {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const candidates = [
    join(appData, 'Code', 'User', 'globalStorage'),
    join(appData, 'Code', 'User', 'workspaceStorage'),
    join(appData, 'Code - Insiders', 'User', 'globalStorage'),
    join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
    join(home, '.config', 'Code', 'User', 'globalStorage'),
    join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    join(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
    join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
    join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
    join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage'),
    join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
  ];

  const trimmedExtraPath = extraPath.trim();
  if (trimmedExtraPath) {
    candidates.unshift(trimmedExtraPath);
  }

  const existingPaths: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate);
      existingPaths.push(candidate);
    } catch {
      // Missing candidate. Continue checking other editor locations.
    }
  }

  return existingPaths;
}
