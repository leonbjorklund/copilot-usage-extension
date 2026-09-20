import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installer = resolve('scripts/install-local.js');
const windows = process.platform === 'win32';

describe('local install', () => {
  for (const editors of [['code'], ['code-insiders'], ['code', 'code-insiders'], []]) {
    const failures = editors.length === 2 ? ['', 'vsce', 'code', 'launch'] : [''];
    for (const failure of failures) {
      it(`installs into ${editors.join(' and ') || 'no editors'}, failure: ${failure || 'none'}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'editor commands '));
        try {
          const log = join(root, 'calls.txt');
          for (const command of ['vsce', ...editors]) {
            const stub = windows
              ? `@echo off\r\necho ${command} %*>>"%EDITOR_TEST_LOG%"\r\n`
              + (failure === 'launch' && command === 'code' ? 'if "%1"=="--new-window" exit /b 7\r\n' : '')
              + `exit /b ${failure === command ? 7 : 0}\r\n`
              : `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> "$EDITOR_TEST_LOG"\n`
              + (failure === 'launch' && command === 'code' ? '[ "$1" = "--new-window" ] && exit 7\n' : '')
              + `exit ${failure === command ? 7 : 0}\n`;
            writeFileSync(join(root, command + (windows ? '.cmd' : '')), stub, { mode: 0o755 });
          }
          const result = spawnSync(process.execPath, [installer], {
            cwd: root, encoding: 'utf8',
            env: { ...process.env, PATH: root, EDITOR_TEST_LOG: log },
          });
          expect(result.status).toBe(failure || !editors.length ? 1 : 0);
          const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/) : [];
          expect(calls).toEqual(editors.length ? [
            'vsce package --no-dependencies --out copilot-usage-extension.vsix',
            ...(failure === 'vsce' ? [] : editors.flatMap(editor => [
              `${editor} --install-extension copilot-usage-extension.vsix --force`,
              ...(failure === editor ? [] : [`${editor} --new-window .`]),
            ])),
          ] : []);
          if (!editors.length) expect(result.stderr).toContain('Neither code nor code-insiders was found on PATH');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
