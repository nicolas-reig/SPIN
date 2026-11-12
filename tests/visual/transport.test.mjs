import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {responseMime,staticGet,installTransport} from './transport.mjs';

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
