import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'sources.json'),'utf8'));
const sources=path.resolve(process.env.AMBIRE_SOURCE_ROOT || path.join(root,'sources'));
function git(args){const r=spawnSync('git',args,{stdio:'inherit'});if(r.status!==0)throw new Error(`Git operation failed (${args[0]})`);}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
for(const label of Object.keys(manifest.sourcePins)){
  for(const variant of ['baseline','candidate']){
    try{await fs.access(path.join(sources,`${label}-${variant}`));throw new Error(`Refusing to replace existing ${label}-${variant}. Choose a fresh AMBIRE_SOURCE_ROOT.`);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
await fs.mkdir(sources,{recursive:true});
for(const [label,commit] of Object.entries(manifest.sourcePins)){
  const baseline=path.join(sources,`${label}-baseline`);
  const candidate=path.join(sources,`${label}-candidate`);
  git(['clone','--filter=blob:none','--depth','1','--no-checkout',manifest.upstreamRepository,baseline]);
  git(['-C',baseline,'fetch','--depth','1','origin',commit]);
  git(['-C',baseline,'checkout','--detach',commit]);
  const actual=spawnSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8'});
  if(actual.status!==0||actual.stdout.trim()!==commit)throw new Error(`Source pin mismatch for ${label}`);
  await fs.cp(baseline,candidate,{recursive:true,filter:p=>!['.git','node_modules','dist','audits'].includes(path.basename(p))});
  const patch=path.join(root,manifest.patches[label].path);
  if(sha(await fs.readFile(patch))!==manifest.patches[label].sha256)throw new Error('Patch hash mismatch');
  git(['-C',candidate,'apply','--check',patch]);
  git(['-C',candidate,'apply',patch]);
  for(const [relative,expected] of Object.entries(manifest.candidateFiles[label])){
    if(sha(await fs.readFile(path.join(candidate,relative)))!==expected)throw new Error(`Patched source mismatch: ${label}/${relative}`);
  }
}
console.log(`Pinned and patched sources ready at ${sources}. Build with AMBIRE_SOURCE_ROOT=${sources}`);
