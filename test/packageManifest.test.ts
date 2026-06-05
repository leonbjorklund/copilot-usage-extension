import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package manifest and publish contents', () => {
  it('packages the production bundle without source maps or stale compiler output', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      main: string;
      license: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      extensionKind?: string[];
      contributes: {
        viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
        viewsContainers: {
          activitybar: Array<{ id: string; title: string; icon: string }>;
        };
        views: Record<string, Array<{ id: string; name: string; icon?: string }>>;
        commands: Array<{ command: string; title: string }>;
        menus?: {
          'view/item/context'?: Array<{ command: string; when: string; group?: string }>;
        };
        configuration: {
          properties: Record<string, unknown>;
        };
      };
    };
    const vscodeIgnore = await readFile('.vscodeignore', 'utf8');

    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.license).toBe('MIT');
    expect(manifest.extensionKind).toEqual(['ui']);
    expect(manifest.scripts['compile:production']).toBe('npm run check-types && node esbuild.js --production');
    expect(manifest.scripts['vscode:prepublish']).toBe('npm run compile:production');
    expect(manifest.scripts.package).toBe('vsce package --no-dependencies');
    expect(vscodeIgnore).toContain('out/**');
    expect(vscodeIgnore).toContain('dist/**/*.map');
    expect(vscodeIgnore).toContain('scripts/**');
    expect(vscodeIgnore).toContain('AGENTS.md');
    expect(vscodeIgnore).toContain('TODO');
    expect(vscodeIgnore).toContain('*.vsix');
    expect(manifest.scripts['install:local']).toBe(
      'vsce package --no-dependencies --out copilot-usage-extension.vsix && code --install-extension copilot-usage-extension.vsix --force && code --new-window .',
    );
    expect(manifest.scripts['generate:logos']).toBeUndefined();
    expect(manifest.scripts.update).toBeUndefined();
    expect(manifest.devDependencies.sharp).toBeUndefined();
    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual({
      id: 'copilotUsage',
      title: 'Copilot Sessions',
      icon: 'logos/logo.svg',
    });
    expect(manifest.contributes.views.explorer).toBeUndefined();
    expect(manifest.contributes.views.copilotUsage).toEqual([
      {
        id: 'copilotUsage.views.usage',
        name: 'Copilot Sessions',
        icon: 'logos/logo.svg',
      },
    ]);
    expect(manifest.contributes.viewsWelcome).toEqual([
      {
        view: 'copilotUsage.views.usage',
        contents: '[Enable Copilot logs to see token use](command:copilotUsage.openCopilotLoggingSetting)',
        when: 'copilotUsage.setupNeeded',
      },
    ]);
    expect(manifest.contributes.commands.map((command) => command.title)).toEqual([
      'Copilot Token Cost: Refresh',
      'Copilot Token Cost: Show Scan Diagnostics',
      'Copilot Token Cost: Open Source Log',
    ]);
    expect(manifest.contributes.menus?.['view/item/context']).toContainEqual({
      command: 'copilotUsage.openSourceLog',
      when: 'view == copilotUsage.views.usage && viewItem == chat',
      group: 'navigation@1',
    });
    expect(Object.keys(manifest.contributes.configuration.properties)).toEqual(['copilotUsage.dataPath']);
  });

  it('debugs the bundled output used by the extension host', async () => {
    const launch = JSON.parse(await readFile('.vscode/launch.json', 'utf8')) as {
      configurations: Array<{ outFiles?: string[] }>;
    };

    expect(launch.configurations[0].outFiles).toEqual(['${workspaceFolder}/dist/**/*.js']);
  });

  it('does not declare stale generation scripts', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts['generate:logos']).toBeUndefined();
  });
});
