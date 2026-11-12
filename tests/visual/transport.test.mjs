import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {responseMime,staticGet,installTransport,assetGate} from './transport.mjs';

test('GLB and unchanged-alpha image bytes are served with actual content type',()=>{
  assert.equal(responseMime(Buffer.from('glTFdata'),'/api.php'),'model/gltf-binary');
  assert.equal(responseMime(Buffer.from('{"floors":[]}'),'/api.php'),'application/json; charset=utf-8');
  assert.equal(responseMime(Buffer.alloc(0),'/js/map.js'),'text/javascript; charset=utf-8');
});
test('Static route cannot escape the disposable frontend root',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'visual-route-'));
  try {
    await mkdir(path.join(root,'frontend'));await writeFile(path.join(root,'frontend/index.html'),'actual HTML');await writeFile(path.join(root,'secret.txt'),'outside');
    assert.equal((await staticGet(root,'/')).body.toString(),'actual HTML');
    assert.equal((await staticGet(root,'/../secret.txt')).status,403);
    assert.equal((await staticGet(root,'/%2e%2e/secret.txt')).status,403);
    assert.equal((await staticGet(root,'/does-not-exist')).status,404);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('Bridge refuses browser mutation before invoking production PHP',async()=>{
  let handle;const audit={requests:[],blockedWrites:[],errors:[]};
  await installTransport({route:async(_pattern,handler)=>{handle=handler;}},'/must-not-be-read',audit);
  let reply;
  await handle({request:()=>({url:()=> 'http://localhost/api.php',method:()=> 'POST'}),fulfill:async result=>{reply=result;}});
  assert.equal(reply.status,405);assert.equal(audit.blockedWrites.length,1);assert.equal(audit.requests.length,0);
});
test('External requests fail closed before reading staged files',async()=>{
  let handle;const audit={requests:[],blockedWrites:[],errors:[]};
  await installTransport({route:async(_pattern,handler)=>{handle=handler;}},'/must-not-be-read',audit);
  let aborted=false;
  await handle({request:()=>({url:()=> 'https://example.invalid/escape',method:()=> 'GET'}),abort:async()=>{aborted=true;}});
  assert(aborted);assert.match(audit.errors[0],/Unexpected external request/);assert.equal(audit.requests.length,0);
});
test('Stale-load gate holds only the chosen asset once and preserves release ordering',async()=>{
  const gate=assetGate('Floors/17/model.glb');
  let released=false;
  await gate.beforeResponse(new URL('http://localhost/api.php?action=asset&id=other'));
  const waiting=gate.beforeResponse(new URL('http://localhost/api.php?action=asset&id=Floors%2F17%2Fmodel.glb')).then(()=>{released=true;});
  await gate.requested;
  assert.equal(released,false);
  // Later matching requests are not held; this is one controlled stale generation.
  await gate.beforeResponse(new URL('http://localhost/api.php?action=asset&id=Floors%2F17%2Fmodel.glb'));
  gate.release();await waiting;assert.equal(released,true);
});
