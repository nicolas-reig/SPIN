import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {phpGet} from './transport.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(process.env.VISUAL_TEST_SOURCE||path.join(here,'../..'));
const data=path.resolve(process.env.VISUAL_TEST_DATA||path.dirname(app));
const python=process.env.PYTHON||'python3';
const php=process.env.PHP||'php';
function command(...args){return JSON.parse(execFileSync(python,[path.join(here,'fixture.py'),...args],{encoding:'utf8',maxBuffer:32*1024*1024}));}

test('Unchanged production PHP bridge returns real fixture snapshot and GLB bytes',async()=>{
  const staged=command('stage','--source',app,'--data',data,'--profile','matrix','--php',php);
  try {
    const response=await phpGet(path.join(staged.root,'WebApp'),'',php);
    assert.equal(response.status,200);
    const snapshot=JSON.parse(response.body.toString());
    assert(snapshot.floors.length>=staged.fixture.floors.length);
    for(const floor of staged.fixture.floors)assert(snapshot.floors.some(item=>item.id===floor.id));
    for(const record of staged.fixture.exhibits) {
      const exhibit=snapshot.exhibits.find(exhibit=>exhibit.id===record.id);
      assert(exhibit,'Generated status fixture exists');
      assert.equal(exhibit.status,record.status);
      assert.equal(exhibit.floorId,record.floor_id);
      assert.equal(exhibit.models.length,record.models);
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
    for(const generated of [...staged.fixture.floors.map(floor=>floor.model_id),...staged.fixture.hardware.map(model=>model.id)]){
      const asset=snapshot.assets.find(item=>item.id===generated);
      assert(asset,'Production Store exposes generated asset '+generated);
      const request=new URL(asset.url,'http://review.test/');
      const result=await phpGet(path.join(staged.root,'WebApp'),request.search.slice(1),php);
      assert.equal(result.status,200);assert.equal(result.contentType,'model/gltf-binary');
      const manifest=staged.staged.assets.files.find(file=>file.path===generated);
      assert.equal(createHash('sha256').update(result.body).digest('hex'),manifest.sha256,'CLI bridge preserves exact generated GLB bytes');
    }
    const bad=await phpGet(path.join(staged.root,'WebApp'),'action=asset&kind=floor&id=not-a-valid-asset',php);
    assert(bad.status>=400,'Actual PHP error status preserved');
    assert(JSON.parse(bad.body.toString()).error);
    const after=command('fingerprint','--source',app,'--data',data);
    for(const key of ['code','assets','exhibits'])assert.equal(after[key].sha256,staged.original[key].sha256);
  } finally {await rm(staged.root,{recursive:true,force:true});}
});
