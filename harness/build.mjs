import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../..');
const workspaceTrees = {
  'pr35-baseline': path.join(workspace, 'work/ambire-source-map/common'),
  'pr35-candidate': path.join(workspace, 'work/ambire-reliability/pr35-patched-common'),
  'current-baseline': path.join(workspace, 'work/ambire-reliability/common'),
  'current-candidate': path.join(workspace, 'work/ambire-reliability/current-patched-common'),
};
let sourceRoot = process.env.AMBIRE_SOURCE_ROOT;
if (!sourceRoot) {
  const prepared = path.resolve(here, '../sources');
  try { if ((await fs.stat(prepared)).isDirectory()) sourceRoot = prepared; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const trees = sourceRoot
  ? Object.fromEntries(Object.keys(workspaceTrees).map(label => [label, path.resolve(sourceRoot, label)]))
  : workspaceTrees;
await fs.mkdir(path.join(here, 'bundles'), { recursive: true });
const provenance = {};
for (const [label, source] of Object.entries(trees)) {
  const activity = path.join(source, 'src/controllers/activity/activity.ts');
  const types = path.join(source, 'src/libs/accountOp/types.ts');
  const provider = path.join(source, 'src/services/provider/getRpcProvider.ts');
  const helper = path.join(source, 'src/libs/activity/activityLookup.ts');
  const entry = `export { ActivityController } from ${JSON.stringify(activity)};\n` +
    `export { AccountOpStatus } from ${JSON.stringify(types)};\n` +
    `export { getRpcProvider } from ${JSON.stringify(provider)};\n` +
    (label.endsWith('candidate') ? `export { ActivityLookups, ActivityLookupTimeoutError } from ${JSON.stringify(helper)};\n` : '');
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: source, sourcefile: `${label}-entry.ts`, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external',
    outfile: path.join(here, 'bundles', label + '.mjs'),
    tsconfig: path.join(source, 'tsconfig.json'), metafile: true, sourcemap: true, logLevel: 'warning'
  });
  provenance[label] = {
    source,
    source_inputs: Object.keys(result.metafile.inputs),
    external_imports: [...new Set(Object.values(result.metafile.outputs).flatMap(o => o.imports).filter(i => i.external).map(i => i.path))],
    code_patching_in_build: false,
  };
}
await fs.writeFile(path.join(here, 'build-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(provenance).map(([k,v]) => [k,{ source_files:v.source_inputs.length, external_imports:v.external_imports }]))));
