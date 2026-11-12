import {readFile} from 'node:fs/promises';
import {snapshotGate} from './transport.mjs';

export async function installMemoryProfiling(context){
  const hook=await readFile(new URL('./profile-hook.mjs',import.meta.url));
  await context.route('**/__visual_profile_hook__.mjs',route=>route.fulfill({status:200,contentType:'text/javascript',body:hook}));
  return snapshotGate();
}

export async function attachMemoryProfiling(page,gate){
  let timeout;
  try{
    await Promise.race([gate.requested,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Initial snapshot did not reach profiling gate')),15000);})]);
    // The app awaits its first snapshot before ensureMap imports/constructs MapView.
    await page.waitForSelector('script[type="importmap"]',{state:'attached'});
    await page.evaluate(async()=>{
      const {MapView}=await import('/js/map.js');
      const {installMapProfiler}=await import('/__visual_profile_hook__.mjs');
      installMapProfiler(MapView);
    });
  }finally{clearTimeout(timeout);gate.release();}
}

export async function memorySample(session,page,name){
  const before=await session.send('Runtime.getHeapUsage');
  await session.send('HeapProfiler.collectGarbage');
  const after=await session.send('Runtime.getHeapUsage');
  const dom=await session.send('Memory.getDOMCounters');
  const scene=await page.evaluate(()=>globalThis.__visualMemory?.snapshot()||null);
  return {name,heap_before_gc:before,heap_after_gc:after,dom,...scene};
}

export const memoryMeasurementNotes=[
  'Chromium Runtime.getHeapUsage before and after explicit HeapProfiler.collectGarbage; these are JavaScript isolate bytes, not total browser RAM.',
  'Renderer geometry/texture counts are actual renderer.info.memory counters; no GPU byte size or GPU process RAM is inferred.',
  'Geometry array-buffer bytes count unique CPU ArrayBuffers reachable from the current scene, including indexes and morph attributes; this is not VRAM.',
  'Profiling hooks run only in separate --memory-only sessions, installed while the initial read-only snapshot response is held. Production HTML and module source stay unchanged.',
  'Cold means a new browser context, empty web storage and cold application scene. Vendor files may remain in the operating-system filesystem cache.',
  'Heap and GPU counters are compared across repeated lifecycle samples; no fixed universal heap limit or total-RAM improvement is inferred.'
];
