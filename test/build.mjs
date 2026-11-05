// Bundles the app so the suites can drive it headlessly.
//   node test/build.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

await build({
  entryPoints: [join(repo, 'src', 'TennisPairingApp.jsx')],
  bundle: true,
  format: 'esm',
  outfile: join(here, '.app-under-test.mjs'),
  loader: { '.jsx': 'jsx' },
  external: ['react', 'react-dom', 'react-dom/client', 'lucide-react', 'xlsx'],
  define: { __BUILD_VERSION__: '"test"' },
  logLevel: 'error',
});
console.log('built test/.app-under-test.mjs');
