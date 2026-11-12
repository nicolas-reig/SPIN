import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('./run.mjs',import.meta.url));
for(const dependency of ['--php','--python']){
  test('Missing '+dependency+' replaces stale success with an incomplete report before any browser import',async()=>{
    const output=await mkdtemp(path.join(os.tmpdir(),'visual-failure-'));
    try{
      await writeFile(path.join(output,'run.json'),'{"complete":true,"frames":[{"name":"stale"}]}');
      const result=spawnSync(process.execPath,[runner,'--output',output,dependency,path.join(output,'missing-executable')],{encoding:'utf8'});
      assert.equal(result.status,1);
      const report=JSON.parse(await readFile(path.join(output,'run.json'),'utf8'));
      assert.equal(report.complete,false);assert.deepEqual(report.frames,[]);
      assert.match(report.failure.message,/missing-executable/);
      assert.equal(report.stage,undefined);assert.equal(report.playwright_version,undefined);
      assert.equal(report.browser_version,undefined);
    }finally{await rm(output,{recursive:true,force:true});}
  });
}
