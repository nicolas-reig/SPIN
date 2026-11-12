#!/usr/bin/env node
/** Two independent captures per revision/profile; exact comparison and real-frame control. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const input=process.argv.slice(2);
function option(name,fallback){const index=input.indexOf(name);return index<0?fallback:input[index+1];}
const baseline=option('--baseline');
if(!baseline)throw Error('Required: --baseline /path/to/frozen/{WebApp,Assets,Exponate}');
const candidate=path.resolve(option('--candidate',path.join(here,'../..')));
const data=path.resolve(option('--data',baseline));
const output=path.resolve(option('--output',path.join(here,'artifacts/suite')));
const python=option('--python',process.env.PYTHON||'python3');
const passthrough=[];
for(const key of ['--browser','--php','--backend','--seed'])if(option(key))passthrough.push(key,option(key));
function run(executable,args){
  const result=spawnSync(executable,args,{stdio:'inherit',cwd:here});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
for(const profile of ['source','matrix']) {
  const root=path.join(output,profile);
  for(const [name,source] of [['baseline-a',path.join(baseline,'WebApp')],['baseline-b',path.join(baseline,'WebApp')],['candidate-a',candidate],['candidate-b',candidate]])
    run(process.execPath,[path.join(here,'run.mjs'),'--source',source,'--data',data,'--output',path.join(root,name),'--profile',profile,'--python',python,...passthrough]);
  for(const [name,a,b] of [['baseline-repeatability','baseline-a','baseline-b'],['candidate-repeatability','candidate-a','candidate-b'],['baseline-vs-candidate','baseline-a','candidate-a']])
    run(python,[path.join(here,'compare.py'),path.join(root,a),path.join(root,b),'--output',path.join(root,name)]);
  run(python,[path.join(here,'negative_control.py'),path.join(root,'baseline-a'),'--output',path.join(root,'negative-control')]);
}
