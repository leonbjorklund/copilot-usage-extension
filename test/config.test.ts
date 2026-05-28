import { describe, expect, it, vi } from 'vitest';

const { getConfiguration } = vi.hoisted(() => ({
  getConfiguration: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration,
  },
}));

import { readConfig } from '../src/core/config';

describe('readConfig', () => {
  it('reads only dataPath from VS Code and returns fixed internal defaults', () => {
    const get = vi.fn((key: string, fallback: unknown) => (key === 'dataPath' ? 'C:\\usage-data' : fallback));
    getConfiguration.mockReturnValue({ get });

    expect(readConfig()).toEqual({
      dataPath: 'C:\\usage-data',
      maxFileSizeMb: 200,
      maxScanDepth: 12,
    });
    expect(getConfiguration).toHaveBeenCalledWith('copilotUsage');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('dataPath', '');
  });
});
