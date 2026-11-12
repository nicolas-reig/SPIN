import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const three=new URL('../../frontend/vendor/three/build/three.webgpu.js',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
  return specifier==='three'?{url:three,shortCircuit:true}:next(specifier,context);
}});
const {GLTFLoader}=await import('../../frontend/vendor/three/examples/jsm/loaders/GLTFLoader.js');
const folder=fileURLToPath(new URL('.',import.meta.url));
function fixture(shape){
  const bytes=execFileSync(process.env.PYTHON||'python3',['-c',
    'import sys;from glb_fixture import hardware_glb,floor_glb;s=sys.argv[1];sys.stdout.buffer.write(floor_glb(42,*map(float,s.split(":")[1:])) if s.startswith("floor:") else hardware_glb(42,s))',shape],{cwd:folder});
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}
test('Actual vendored GLTFLoader parses every self-contained randomized shape without network',async()=>{
  for(const shape of ['closed-indexed','wedge-open','nested-shared','skinned']){
    const gltf=await new GLTFLoader().parseAsync(fixture(shape),'');
    const meshes=[];gltf.scene.traverse(object=>{if(object.isMesh)meshes.push(object);});
    assert.equal(meshes.length,shape==='nested-shared'?2:1);
    assert.equal(meshes.some(mesh=>mesh.isSkinnedMesh),shape==='skinned');
    for(const mesh of meshes){
      assert(mesh.geometry.attributes.position.count>=30);
      assert([...mesh.geometry.attributes.position.array].every(Number.isFinite));
      assert(mesh.geometry.attributes.normal);
    }
    if(shape==='nested-shared')assert.equal(meshes[0].geometry,meshes[1].geometry,'The repeated mesh really shares one geometry');
  }
});
test('Actual vendored GLTFLoader parses all generated floor dimensions and nested mirrored nodes',async()=>{
  for(const [width,depth] of [[4,3],[24,18],[150,90]]){
    const gltf=await new GLTFLoader().parseAsync(fixture('floor:'+width+':'+depth),'');
    gltf.scene.updateMatrixWorld(true);
    const meshes=[];gltf.scene.traverse(object=>{if(object.isMesh)meshes.push(object);});
    assert.equal(meshes.length,6);
    assert(meshes.some(mesh=>mesh.matrixWorld.determinant()<0));
    assert(meshes.every(mesh=>[...mesh.geometry.attributes.position.array].every(Number.isFinite)));
  }
});
