import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryInventory,installMapProfiler} from './profile-hook.mjs';

test('Inventory counts shared/interleaved/morph CPU buffers once and includes line geometry',()=>{
  const shared=new Float32Array(24),morph=new Float32Array(12),index=new Uint16Array(6);
  const geometry={attributes:{position:{array:shared},normal:{data:{array:shared}}},
    morphAttributes:{position:[{array:morph}]},index:{array:index}};
  const material={};
  const root={traverse(callback){callback({});for(let i=0;i<3;i++)callback({isMesh:i<2,isLine:i===2,geometry,material});}};
  assert.deepEqual(geometryInventory(root),{objects:4,meshes:2,skinned_meshes:0,unique_geometries:1,
    unique_materials:1,geometry_array_buffer_bytes:shared.byteLength+morph.byteLength+index.byteLength});
});
test('Read-only instrumentation observes concurrent superseded builds without retaining scene resources',async()=>{
  const resolvers=[];
  class Map {
    generation=0;floor=null;
    init(){return this;}model(){return 7;}clearScene(){}destroy(){this.destroyed=true;}
    setData(){this.generation++;return new Promise(resolve=>resolvers.push(resolve));}
  }
  const target={};const probe=installMapProfiler(Map,target);const map=new Map();
  assert.equal(map.init(),map);assert.equal(map.model(),7);
  const first=map.setData(),second=map.setData();
  assert.equal(probe.snapshot().counts.pending_set_data,2);
  resolvers[1]();await second;resolvers[0]();await first;
  const snapshot=probe.snapshot();
  assert.equal(snapshot.counts.max_pending_set_data,2);
  assert.equal(snapshot.counts.pending_set_data,0);
  assert.equal(snapshot.counts.superseded_completions,1);
  assert.equal(snapshot.map.generation,2);
  assert.doesNotThrow(()=>JSON.stringify(snapshot));
  probe.destroy();assert(map.destroyed);assert.equal(probe.snapshot().counts.destroy_calls,1);
});
