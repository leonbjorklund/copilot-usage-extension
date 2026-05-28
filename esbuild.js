const esbuild = require('esbuild');
const fs = require('node:fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  fs.rmSync('dist', { recursive: true, force: true });

  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    platform: 'node',
    sourcemap: production ? false : true,
    sourcesContent: false,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'warning',
  });

  if (watch) {
    await context.watch();
    return;
  }

  await context.rebuild();
  await context.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
