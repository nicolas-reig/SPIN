import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {phpGet} from './transport.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(process.env.VISUAL_TEST_SOURCE||path.join(here,'../..'));
const data=path.resolve(process.env.VISUAL_TEST_DATA||path.dirname(app));
const python=process.env.PYTHON||'python3';
const php=process.env.PHP||'php';
function command(...args){return JSON.parse(execFileSync(python,[path.join(here,'fixture.py'),...args],{encoding:'utf8',maxBuffer:32*1024*1024}));}

test('Unchanged production PHP bridge returns real fixture snapshot and GLB bytes',async()=>{
  const staged=command('stage','--source',app,'--data',data,'--profile','matrix');
  try {
    const response=await phpGet(path.join(staged.root,'WebApp'),'',php);
    assert.equal(response.status,200);
    const snapshot=JSON.parse(response.body.toString());
    assert.equal(snapshot.floors.length,3);
    assert(snapshot.floors.some(floor=>floor.id==='-1'));
    assert(snapshot.floors.some(floor=>floor.id==='1'));
    for(const status of ['ok','problem','retired']) {
      const exhibit=snapshot.exhibits.find(exhibit=>exhibit.name==='Visual '+status);
      assert(exhibit,'Generated status fixture exists');
      assert.equal(exhibit.status,status);
      assert.equal(exhibit.models.length,3);
      assert.equal(exhibit.notes.length,1);
      assert.equal(exhibit.links.length,1);
    }
    const floorAsset=snapshot.assets.find(asset=>asset.kind==='floor');
    assert(floorAsset,'Production Store exposed floor GLB');
    const url=new URL(floorAsset.url,'http://review.test/');
    const model=await phpGet(path.join(staged.root,'WebApp'),url.search.slice(1),php);
    assert.equal(model.status,200);
    assert.equal(model.contentType,'model/gltf-binary');
    assert.equal(model.body.subarray(0,4).toString(),'glTF');
    const bad=await phpGet(path.join(staged.root,'WebApp'),'action=asset&kind=floor&id=not-a-valid-asset',php);
    assert(bad.status>=400,'Actual PHP error status preserved');
    assert(JSON.parse(bad.body.toString()).error);
    const after=command('fingerprint','--source',app,'--data',data);
    for(const key of ['code','assets','exhibits'])assert.equal(after[key].sha256,staged.original[key].sha256);
  } finally {await rm(staged.root,{recursive:true,force:true});}
});
