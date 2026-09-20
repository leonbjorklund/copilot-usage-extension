const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const windows = process.platform === 'win32';
const editors = ['code', 'code-insiders'].filter(editor => {
  const result = windows
    ? spawnSync(join(process.env.SystemRoot, 'System32', 'where.exe'), [editor])
    : spawnSync('/bin/sh', ['-c', `command -v ${editor}`]);
  return result.status === 0;
});

function run(command, args) {
  // Windows npm and VS Code CLIs are .cmd shims; all arguments here are fixed.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: windows });
  if (result.error) console.error(result.error.message);
  return result.status === 0;
}

if (!editors.length) {
  console.error('Neither code nor code-insiders was found on PATH. Add your VS Code bin folder to PATH and retry.');
  process.exit(1);
}
if (!run('vsce', ['package', '--no-dependencies', '--out', 'copilot-usage-extension.vsix'])) {
  process.exit(1);
}
for (const editor of editors) {
  if (!run(editor, ['--install-extension', 'copilot-usage-extension.vsix', '--force'])) {
    console.error(`${editor} installation failed.`);
    process.exitCode = 1;
    continue;
  }
  if (!run(editor, ['--new-window', '.'])) {
    console.error(`${editor} launch failed.`);
    process.exitCode = 1;
  }
}
