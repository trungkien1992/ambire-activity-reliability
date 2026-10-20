import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
const workspace=path.resolve(here,'../../..');
let sourceRoot=process.env.AMBIRE_SOURCE_ROOT;
if(!sourceRoot){
  const prepared=path.resolve(here,'../sources');
  try{if((await fs.stat(prepared)).isDirectory())sourceRoot=prepared;}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const trees=sourceRoot?['pr35','current'].map(k=>path.resolve(sourceRoot,`${k}-candidate`)):[path.join(workspace,'work/ambire-reliability/pr35-patched-common'),path.join(workspace,'work/ambire-reliability/current-patched-common')];
const helpers=await Promise.all(trees.map(t=>fs.readFile(path.join(t,'src/libs/activity/activityLookup.ts'))));
if(!helpers[0].equals(helpers[1]))throw new Error('Helpers differ; typecheck each separately');
const temp=path.join(here,'activityLookup.typecheck.ts');
await fs.writeFile(temp,helpers[0]);
const typeArgs=['--noEmit','--strict','--noImplicitReturns','--noUncheckedIndexedAccess','--target','ES2022','--module','ES2022','--moduleResolution','node','--lib','ES2022,DOM','--types','node','--skipLibCheck',temp];
const t=spawnSync(process.execPath,[path.join(here,'node_modules/typescript/bin/tsc'),...typeArgs],{stdio:'inherit'});
await fs.rm(temp);
const changed=trees.flatMap(t=>['src/libs/activity/activityLookup.ts','src/controllers/activity/activity.ts'].map(p=>path.join(t,p)));
const p=spawnSync(process.execPath,[path.join(here,'node_modules/prettier/bin/prettier.cjs'),'--check','--print-width','100','--single-quote','--no-semi','--trailing-comma','none',...changed],{stdio:'inherit'});
const report={generatedAt:new Date().toISOString(),helperSha256:createHash('sha256').update(helpers[0]).digest('hex'),identicalCandidateHelpers:true,helperStrictTypecheckPassed:t.status===0,changedFileFormattingPassed:p.status===0,typescriptVersion:'5.9.3',prettierVersion:'3.3.3',strictFlags:typeArgs.slice(0,-1),scope:'Strict check of new helper only; actual controllers bundled and runtime tested separately. Full upstream repository typecheck/Jest/ESLint not run.'};
await fs.writeFile(path.join(here,'source-check-results.json'),JSON.stringify(report,null,2)+'\n');
if(t.status!==0||p.status!==0)process.exitCode=1;
