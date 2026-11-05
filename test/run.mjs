// Runs every suite and reports a single verdict.
//   node test/run.mjs
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

// Always test the current source, never a stale bundle.
const built = spawnSync(process.execPath, [join(here, 'build.mjs')], { encoding: 'utf8' });
if (built.status !== 0) { console.error(built.stderr || built.stdout); process.exit(1); }

let failed = 0;
for (const suite of suites) {
  const r = spawnSync(process.execPath, [join(here, suite)], {
    encoding: 'utf8',
    env: { ...process.env, IS_REACT_ACT_ENVIRONMENT: '1' },
  });
  const out = r.stdout || '';
  const line = (out.match(/^\d+ passed, \d+ failed$/m) || ['(no verdict)'])[0];
  const bad = !/0 failed/.test(line);
  if (bad) failed += 1;
  console.log(`${bad ? 'FAIL' : 'ok  '}  ${suite.padEnd(20)} ${line}`);
  if (bad) console.log(out.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exit(failed ? 1 : 0);
