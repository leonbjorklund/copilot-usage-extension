const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
}).catch(() => process.exit(1));
