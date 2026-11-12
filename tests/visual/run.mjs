#!/usr/bin/env node
/** Real browser/app frames, synthetic transport only. Does not open a listening socket. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { installTransport, phpGet, TEST_ORIGIN, assetGate } from './transport.mjs';
import {installMemoryProfiling,attachMemoryProfiling,memorySample,memoryMeasurementNotes} from './browser-memory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const input = process.argv.slice(2);
function option(name, fallback) {const index=input.indexOf(name); return index<0 ? fallback : input[index+1];}
const source = path.resolve(option('--source', path.join(here,'../..')));
const data = path.resolve(option('--data', path.dirname(source)));
const output = path.resolve(option('--output', path.join(here,'artifacts/run')));
const memoryOnly=input.includes('--memory-only');
const profile = option('--profile',memoryOnly?'matrix':'source');
assert(!memoryOnly || profile==='matrix','--memory-only requires --profile matrix');
const memoryRuns=Number(option('--memory-runs','3'));
const memoryCycles=Number(option('--memory-cycles','5'));
assert(Number.isInteger(memoryRuns) && memoryRuns>=2 && memoryRuns<=20,'--memory-runs must be between 2 and 20');
assert(Number.isInteger(memoryCycles) && memoryCycles>=2 && memoryCycles<=50,'--memory-cycles must be between 2 and 50');
const seed = option('--seed','271828');
assert(/^-?\d+$/.test(seed), '--seed must be an integer');
assert(['source','matrix'].includes(profile), '--profile must be source or matrix');
const python = option('--python',process.env.PYTHON || 'python3');
const php = option('--php',process.env.PHP || 'php');
const backend = option('--backend','webgl');
assert(['webgl','webgpu'].includes(backend), '--backend must be webgl or webgpu');
const epoch = '2026-11-12T12:00:00.000Z';
const viewport = {width:1440,height:1000};
const args = ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--force-color-profile=srgb'];
if (backend === 'webgpu') args.push('--enable-unsafe-webgpu');
const report = {complete:false, run_kind:memoryOnly?'memory':'visual',started:new Date().toISOString(), source, data, profile, backend,
  viewport, device_scale_factor:1, clock_epoch:epoch, browser_arguments:args,
  environment:{platform:os.platform(),release:os.release(),arch:os.arch(),node:process.version,
    php:null,python:null}, frames:[], assertions:[], contexts:[]};
let browser;
let contextSerial=0;
const active = new Set();
const gates = new Set();
await mkdir(output,{recursive:true});
async function saveReport() {await writeFile(path.join(output,'run.json'), JSON.stringify(report,null,2)+'\n');}
function pythonJSON(command) {return JSON.parse(execFileSync(python,[path.join(here,'fixture.py'), ...command],{encoding:'utf8',maxBuffer:32*1024*1024}));}
async function advance(page,ms=400) {
  const before=await page.evaluate(()=>Date.now());
  await page.clock.runFor(ms); await page.waitForTimeout(25);
  assert.equal(await page.evaluate(()=>Date.now()),before+ms,'Paused application clock advances by exactly the requested interval');
}
async function cssSettled(page) {
  // Playwright's JS clock does not control the compositor's CSS animation timeline.
  // Wait for real finite transitions without advancing application RAF timestamps.
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const active=await page.evaluate(()=>document.getAnimations().filter(animation=>
      animation.playState==='running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).length);
    if(!active)return;
    await page.waitForTimeout(25);
  }
  throw Error('Finite CSS animations did not settle');
}
let scenarioPlan;
function exhibitLocator(page,id) {return page.locator('[data-select='+JSON.stringify(id)+']');}

async function until(page, predicate, label, timeout=60000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {if(await page.evaluate(predicate)) return; await advance(page,80);}
  throw Error('Timed out: '+label);
}
async function mapReady(page, mode) {
  await until(page,()=>document.querySelector('#map-canvas canvas')?.dataset.cameraOffset && document.querySelector('#map-message')?.textContent==='' && !document.querySelector('#map-canvas')?.classList.contains('floor-loading'),'geometry ready');
  if(mode) assert.equal(await page.locator('#map-canvas canvas').getAttribute('data-view'),mode);
  assert.equal(await page.locator('#map-canvas canvas').getAttribute('data-renderer'), backend==='webgl' ? 'webgl2' : 'webgpu');
  await advance(page,1200);
  const offset=(await page.locator('#map-canvas canvas').getAttribute('data-camera-offset')).split(',').map(Number);
  assert(offset.length===3 && offset.every(Number.isFinite), 'finite camera offset');
}
async function fresh(params='', {palette='default',mobile=false,accessibility=false,unavailable=false,floor=scenarioPlan.floorId}={}) {
  const audit={name:'context-'+(++contextSerial),requests:[],blockedWrites:[],errors:[],pageErrors:[],consoleErrors:[]};
  const control={};
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:viewport,deviceScaleFactor:1,locale:'de-DE',timezoneId:'UTC',colorScheme:'light',reducedMotion:'no-preference',serviceWorkers:'block'});
  active.add(context); report.contexts.push(audit);
  await installTransport(context,path.join(report.stage.root,'WebApp'),audit,php,control);
  if(memoryOnly){control.gate=await installMemoryProfiling(context);gates.add(control.gate);}
  await context.addInitScript(({palette})=>{
    localStorage.clear(); localStorage.setItem('hub-language','de');
    if(palette!=='default') localStorage.setItem('hub-color-scheme',palette);
  },{palette});
  const page=await context.newPage();
  page.on('pageerror',error=>audit.pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') audit.consoleErrors.push(message.text());});
  await page.clock.install({time:new Date(epoch)});
  await page.clock.pauseAt(new Date(Date.parse(epoch)+1000));
  const suffix=backend==='webgl'?'webgl=1':'';
  const query=new URLSearchParams(params);
  if(floor!==undefined)query.set('floor',floor);
  const target=accessibility?'accessibility.html?return=%2Findex.html':'index.html?'+[suffix,query.toString()].filter(Boolean).join('&');
  await page.goto(TEST_ORIGIN+'/'+target,{waitUntil:memoryOnly?'commit':'domcontentloaded'});
  if(memoryOnly){
    const gate=control.gate;
    await attachMemoryProfiling(page,gate);gates.delete(gate);delete control.gate;
    await page.waitForLoadState('domcontentloaded');
  }
  await until(page,()=>document.fonts.status==='loaded','fonts loaded');
  if(accessibility) await until(page,()=>document.querySelectorAll('.palette-option').length===5,'palette cards');
  else {
    await until(page,()=>document.querySelector('[data-select]'),'exhibits loaded');
    if(mobile) await page.locator('[data-action="view:map"]').click();
    if(unavailable) await until(page,()=>Boolean(document.querySelector('#map-message')?.textContent),'map unavailable message');
    else await mapReady(page);
  }
  return {page,context,audit,control};
}
async function done(session) {
  const {audit,context}=session;
  assert.deepEqual(audit.blockedWrites,[], 'No persisted writes in visual scenarios');
  assert.deepEqual(audit.errors,[], 'No failed transport requests');
  assert.deepEqual(audit.pageErrors,[], 'No uncaught page errors');
  assert.deepEqual(audit.consoleErrors,[], 'No browser console errors');
  await context.close();active.delete(context);
  assert.deepEqual(audit.pageErrors,[], 'No errors while closing browser context');
  assert.deepEqual(audit.consoleErrors,[], 'No console errors while closing browser context');
}
async function frame(page,name,{map=true,wait=600,animation_ms=null}={}) {
  assert(!report.frames.some(frame=>frame.name===name),'Unique frame name '+name);
  if(wait) await advance(page,wait);
  await cssSettled(page);
  const captureClock=await page.evaluate(()=>Date.now());
  const canvas=map?await page.locator('#map-canvas canvas').boundingBox():null;
  if(map) assert(canvas && canvas.width>100 && canvas.height>100, 'Visible canvas '+name);
  const metadata=await page.evaluate(()=>({url:location.pathname+location.search,view:document.body.dataset.view||null,
    colorMode:document.documentElement.dataset.colorMode||null,selected:document.querySelector('.exhibit-row[aria-pressed="true"]')?.dataset.select||null,
    floor:document.querySelector('[data-floor][aria-current="true"]')?.dataset.floor||null,
    editing:document.body.classList.contains('editing'),canvasState:{...document.querySelector('#map-canvas canvas')?.dataset},
    viewport:{width:innerWidth,height:innerHeight},heading:document.querySelector('#inspector h1')?.textContent||null,
    openDialog:Boolean(document.querySelector('dialog[open]')),openMenus:document.querySelectorAll('.floating-popover,.selection-menu,.status-menu[aria-hidden="false"]').length}));
  const file=name+'.png';
  await page.screenshot({path:path.join(output,file),animations:'allow',caret:'hide',scale:'css',fullPage:false});
  assert.equal(await page.evaluate(()=>Date.now()),captureClock,'Screenshot encoding leaves application clock paused');
  report.frames.push({name,file,canvas,...metadata,clock_frozen:true,capture_clock_ms:captureClock,animation_ms});
  await saveReport();
}
async function repeats(page,name) {
  await frame(page,name+'-settled-0');
  await frame(page,name+'-settled-500ms',{wait:500});
  await frame(page,name+'-settled-2000ms',{wait:1500});
}
async function select(page,id) {
  const locator=exhibitLocator(page,id);
  await locator.click();
  await advance(page,1200);
  assert.equal(await locator.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#inspector h1').textContent(),id);
}
async function command(page,name) {await page.locator('#map-controls [data-camera-command="'+name+'"]').click();}
async function closeMenu(page) {await page.keyboard.press('Escape');await advance(page,400);}
async function enterEdit(page) {
  await page.locator('.app-menu > summary').click();await advance(page,400);
  await page.locator('[data-action=enterEdit]').click();await advance(page,1200);
  assert(await page.locator('body').evaluate(element=>element.classList.contains('editing')));
}
async function coreScenes() {
  for(const style of ['thickness','height','shaded']) {
    const s=await fresh('map2d='+style+'&view=top');const p=s.page;
    await mapReady(p,'top');
    assert.equal(await p.locator('#map-canvas canvas').getAttribute('data-map2d'),style);
    await repeats(p,'source-'+style+'-2d');
    const id=scenarioPlan.exhibitId;
    await exhibitLocator(p,id).hover();await frame(p,'source-'+style+'-list-hover');
    await select(p,id);await frame(p,'source-'+style+'-selected');
    await p.locator('.status-toggle').click();await frame(p,'source-'+style+'-status-menu');
    assert.equal(await p.locator('.status-toggle').getAttribute('aria-expanded'),'true');
    assert.equal(await p.locator('[role=menuitemradio]').count(),3);
    await closeMenu(p);
    await command(p,'perspective');await mapReady(p,'perspective');
    await repeats(p,'source-'+style+'-3d');
    await command(p,'zoomIn');await frame(p,'source-'+style+'-zoomed');
    await command(p,'turnRight');await frame(p,'source-'+style+'-turned');
    await p.locator('#map-canvas canvas').press('ArrowLeft');await frame(p,'source-'+style+'-keyboard-pan');
    await done(s);
  }
}
async function uiStates() {
  const s=await fresh('view=top');const p=s.page;
  await p.locator('.filter-menu > summary').click();await frame(p,'ui-filters');
  await p.locator('#status-filter + .select-button').click();await frame(p,'ui-status-filter-list');
  assert.equal(await p.locator('[role=listbox] [role=option]').count(),4);await closeMenu(p);await closeMenu(p);
  await p.locator('.app-menu > summary').click();await frame(p,'ui-app-menu');await closeMenu(p);
  await p.locator('#search').fill('No deterministic exhibit matches this phrase');await frame(p,'ui-search-empty');
  assert.equal(await p.locator('[data-select]').count(),0);await p.locator('#search').fill('');
  const id=scenarioPlan.exhibitId;await select(p,id);
  await p.locator('[data-tab=documentation]').click();await frame(p,'ui-documentation');
  await p.locator('[data-tab=notes]').click();await frame(p,'ui-posts');
  await p.locator('#resizer').focus();await p.keyboard.press('ArrowLeft');await frame(p,'ui-inspector-wider');
  await p.setViewportSize({width:1100,height:780});await frame(p,'ui-resize-1100');
  await p.setViewportSize(viewport);await advance(p,1000);
  await enterEdit(p);await frame(p,'edit-inspector');
  await p.locator('.hardware-picker > summary').click();await frame(p,'edit-hardware-picker');await closeMenu(p);
  await p.locator('.instance-placement > summary').first().click();await frame(p,'edit-instance-placement');
  await p.locator('.exhibit-transform > summary').click();await frame(p,'edit-group-placement');
  const position=p.locator('[data-group-vector][data-vector=position][data-axis="0"]');
  const oldValue=Number(await position.inputValue());
  await position.fill(String(oldValue+1));await position.press('Tab');await frame(p,'edit-position-draft');
  assert.equal(await position.inputValue(),String(oldValue+1));
  await p.locator('[data-action=undo]').click();await frame(p,'edit-undo');
  assert.equal(Number(await position.inputValue()),oldValue);
  await p.locator('[data-action=redo]').click();await frame(p,'edit-redo');
  assert.equal(Number(await position.inputValue()),oldValue+1);
  await p.locator('[data-tool=translate]').click();await frame(p,'edit-translation-gizmo');
  await p.locator('.transform-options > summary').click();await frame(p,'edit-transform-options');
  await p.locator('#axis + .select-button').click();await frame(p,'edit-axis-list');await closeMenu(p);await closeMenu(p);
  await p.locator('.view-presets > summary').click();await frame(p,'edit-view-presets');
  await p.locator('[data-set-view="2D"]').click();await frame(p,'edit-view-captured');
  assert.equal(await p.locator('[data-reset-view="2D"]').isEnabled(),true);
  await p.locator('[data-action=saveExit]').click();await frame(p,'edit-signature');
  assert.equal(await p.locator('[data-action=confirmEditSave]').isDisabled(),true);
  await p.locator('[data-action=cancelEditSignature]').click();
  await p.locator('[data-action=renameExhibit]').click();await frame(p,'edit-rename-dialog');
  assert.equal(await p.locator('dialog').getAttribute('open'),'');await closeMenu(p);
  await p.locator('[data-remove-instance]').first().click();await frame(p,'edit-remove-hardware-dialog');await closeMenu(p);
  await p.locator('[data-trash-exhibit]').first().click();await frame(p,'edit-delete-exhibit-dialog');await closeMenu(p);
  await p.locator('[data-action=cancelEdit]').click();await frame(p,'edit-cancelled');
  assert.equal(await p.locator('body').evaluate(element=>element.classList.contains('editing')),false);
  await p.locator('[data-action=restoreEdit]').click();await frame(p,'edit-restored-draft');
  assert.equal(await p.locator('body').evaluate(element=>element.classList.contains('editing')),true);
  await p.locator('[data-action=cancelEdit]').click();
  await done(s);
}
async function cameraFrames() {
  const s=await fresh('view=top');const p=s.page;
  const id=scenarioPlan.exhibitId;
  // Clock is paused; exact app RAF times remain fixed even while screenshots encode.
  await p.locator('[data-select='+JSON.stringify(id)+']').click();
  await frame(p,'camera-select-000ms',{wait:0,animation_ms:0});
  await frame(p,'camera-select-064ms',{wait:64,animation_ms:64});
  await frame(p,'camera-select-128ms',{wait:64,animation_ms:128});
  await frame(p,'camera-select-256ms',{wait:128,animation_ms:256});
  await frame(p,'camera-select-1256ms',{wait:1000,animation_ms:1256});
  // Selection only reframes hidden exhibits; an already-visible one may keep its camera.
  assert.equal(await p.locator('[data-select='+JSON.stringify(id)+']').getAttribute('aria-pressed'),'true');
  await command(p,'perspective');await mapReady(p,'perspective');
  const beforeTurn=await p.locator('#map-canvas canvas').getAttribute('data-camera-offset');
  await command(p,'turnRight');await frame(p,'camera-explicit-turn');
  assert.notEqual(await p.locator('#map-canvas canvas').getAttribute('data-camera-offset'),beforeTurn,'Explicit perspective turn changes camera');
  await command(p,'focus');await advance(p,1200);
  await command(p,'zoomIn');await command(p,'turnRight');await advance(p,400);
  await command(p,'focus');
  const animationOffsets=[];
  for(const [elapsed,wait] of [[0,0],[64,64],[128,64],[256,128],[1256,1000]]){
    await frame(p,'camera-focus-'+String(elapsed).padStart(4,'0')+'ms',{wait,animation_ms:elapsed});
    animationOffsets.push(await p.locator('#map-canvas canvas').getAttribute('data-camera-offset'));
  }
  assert.notEqual(animationOffsets[0],animationOffsets[4],'Explicit focus reaches a different camera position');
  assert.notEqual(animationOffsets[1],animationOffsets[2],'Camera animation has distinct intermediate states');
  assert.equal(animationOffsets[3],animationOffsets[4],'Camera animation settles by 256 ms');
  const rect=await p.locator('#map-canvas canvas').boundingBox();
  const x=rect.x+rect.width*.55,y=rect.y+rect.height*.55;
  await p.mouse.move(x,y);await p.mouse.down({button:'right'});await p.mouse.move(x+80,y+30,{steps:8});await p.mouse.up({button:'right'});
  await repeats(p,'camera-orbit');
  await p.mouse.move(x,y);await p.mouse.down();await p.mouse.move(x+60,y,{steps:6});await p.mouse.up();
  await frame(p,'camera-pointer-pan');await done(s);
}
async function mobileStates() {
  const s=await fresh('view=top',{mobile:true});const p=s.page;
  await frame(p,'mobile-map');
  await p.locator('[data-action="view:list"]').click();await frame(p,'mobile-list',{map:false});
  await select(p,scenarioPlan.exhibitId);
  await p.locator('[data-action="view:detail"]').click();await frame(p,'mobile-detail',{map:false});
  await p.locator('.status-toggle').click();await frame(p,'mobile-status-menu',{map:false});await closeMenu(p);
  await p.locator('[data-action="view:list"]').click();
  await p.locator('.app-menu > summary').click();await frame(p,'mobile-app-menu',{map:false});
  await done(s);
  const unavailable=await fresh('no3d=1',{unavailable:true});
  assert.equal(await unavailable.page.locator('#map-canvas canvas').count(),0);
  await frame(unavailable.page,'map-unavailable',{map:false});await done(unavailable);
}
async function accessibilityStates() {
  const s=await fresh('',{accessibility:true});const p=s.page;
  await frame(p,'accessibility-default',{map:false});
  for(const palette of ['protanopia','deuteranopia','tritanopia','achromatopsia']) {
    await p.locator('.palette-option').filter({has:p.locator('#palette-'+palette)}).click();
    assert.equal(await p.locator('#palette-'+palette).isChecked(),true);
    assert.equal(await p.locator('html').getAttribute('data-color-mode'),palette);
    await frame(p,'accessibility-'+palette,{map:false});
  }
  await p.locator('[data-language=en]').click();assert.equal(await p.locator('html').getAttribute('lang'),'en');
  await frame(p,'accessibility-english',{map:false});
  await done(s);
  for(const palette of ['protanopia','deuteranopia','tritanopia','achromatopsia']) {
    const scene=await fresh('view=top',{palette});await frame(scene.page,'palette-map-'+palette);await done(scene);
  }
}
async function matrixStates() {
  if(profile!=='matrix')return;
  const fixture=report.stage.fixture;
  const home=fixture.home_floor;
  const byStatus=status=>fixture.exhibits.find(exhibit=>exhibit.floor_id===home && exhibit.status===status).id;
  const s=await fresh('view=top',{floor:home});const p=s.page;
  for(const status of ['ok','problem','retired']) {
    await select(p,byStatus(status));await frame(p,'matrix-status-'+status);
    assert.equal(await p.locator('.status-choice[aria-checked=true]').getAttribute('data-status-choice'),status);
  }
  for(const [index,item] of fixture.floors.entries()) {
    await p.locator('[data-floor='+JSON.stringify(item.id)+']').click();await mapReady(p);await frame(p,'matrix-floor-'+index);
    assert.equal(await p.locator('[data-floor='+JSON.stringify(item.id)+']').getAttribute('aria-current'),'true');
  }
  // The first DOM floor button depends on all original floors, not a fixed numeric ID.
  const firstFloor=await p.locator('[data-floor]').first().getAttribute('data-floor');
  await p.locator('[data-floor='+JSON.stringify(home)+']').focus();await p.keyboard.press('Home');await mapReady(p);
  assert.equal(await p.locator('[data-floor][aria-current=true]').getAttribute('data-floor'),firstFloor);
  await frame(p,'matrix-floor-keyboard');
  for(const item of fixture.floors)await p.locator('[data-floor='+JSON.stringify(item.id)+']').click();
  await p.locator('[data-floor='+JSON.stringify(home)+']').click();
  await mapReady(p);assert.equal(await p.locator('[data-floor][aria-current=true]').getAttribute('data-floor'),home);
  await frame(p,'matrix-floor-rapid-return');
  await frame(p,'matrix-stale-settled-0');
  const delayed=fixture.floors.find(item=>item.id!==home);
  const gate=assetGate(delayed.model_id);gates.add(gate);s.control.gate=gate;
  await p.locator('[data-floor='+JSON.stringify(delayed.id)+']').click();
  let timeout;
  try {
    await Promise.race([gate.requested,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Stale floor request did not reach the gate')),15000);})]);
    await p.locator('[data-floor='+JSON.stringify(home)+']').click();await mapReady(p);
  } finally {clearTimeout(timeout);gate.release();gates.delete(gate);delete s.control.gate;}
  await advance(p,1200);await mapReady(p);
  assert.equal(await p.locator('[data-floor][aria-current=true]').getAttribute('data-floor'),home);
  await frame(p,'matrix-stale-settled-after-release');
  await select(p,byStatus('ok'));await frame(p,'matrix-post-rich-content');
  await p.locator('.note .note-options > summary').first().click();await frame(p,'matrix-post-options');await closeMenu(p);
  await p.locator('[data-delete-note]').first().click();await frame(p,'matrix-delete-post-dialog');await closeMenu(p);
  await p.locator('#note-body').click();await p.locator('#note-body').fill('Deterministic unsaved post');await frame(p,'matrix-post-composer');
  await p.locator('#note-form .note-options > summary').click();await frame(p,'matrix-composer-options');
  await p.locator('#note-status + .select-button').click();await frame(p,'matrix-composer-status-list');await closeMenu(p);await closeMenu(p);
  await p.locator('#note-form .post-button').click();await frame(p,'matrix-post-signature');
  assert.equal(await p.locator('[data-action=confirmNote]').isDisabled(),true);
  await p.locator('[data-action=cancelSignature]').click();
  await p.locator('#note-form .note-options > summary').click();await advance(p,400);
  await p.locator('[data-action=discardDraft]').click();
  await p.locator('[data-tab=documentation]').click();await frame(p,'matrix-documentation-content');
  await p.locator('#link-results .note-options > summary').first().click();await frame(p,'matrix-documentation-options');await closeMenu(p);
  await p.locator('[data-delete-link]').first().click();await frame(p,'matrix-delete-documentation-dialog');await closeMenu(p);
  await p.locator('#link-results .note-options > summary').first().click();await advance(p,400);
  await p.locator('[data-edit-link]').first().click();await frame(p,'matrix-documentation-editor');
  await p.locator('[data-action=cancelLink]').click();
  await enterEdit(p);
  await exhibitLocator(p,byStatus('problem')).click({modifiers:['Shift']});await frame(p,'matrix-edit-multiselect');
  assert.equal(await p.locator('.exhibit-row[aria-pressed=true]').count(),2);
  await done(s);
  // Every generated scale and model topology is also rendered with all 2D styles and in 3D.
  for(const style of ['thickness','height','shaded']){
    const scene=await fresh('map2d='+style+'&view=top',{floor:home});
    for(const [index,item] of fixture.floors.entries()){
      await scene.page.locator('[data-floor='+JSON.stringify(item.id)+']').click();await mapReady(scene.page,'top');
      assert.equal(await scene.page.locator('#map-canvas canvas').getAttribute('data-map2d'),style);
      await frame(scene.page,'matrix-'+style+'-floor-'+index+'-2d');
      await command(scene.page,'perspective');await mapReady(scene.page,'perspective');
      await frame(scene.page,'matrix-'+style+'-floor-'+index+'-3d');
      await command(scene.page,'top');await mapReady(scene.page,'top');
    }
    await done(scene);
  }
}

async function memoryStates(){
  const fixture=report.stage.fixture,home=fixture.home_floor;
  const targets=fixture.exhibits.filter(exhibit=>exhibit.floor_id===home);
  report.memory_profile={notes:memoryMeasurementNotes,repetitions:memoryRuns,rebuild_cycles:memoryCycles,runs:[]};
  for(let run=0;run<memoryRuns;run++){
    const s=await fresh('view=top',{floor:home}),p=s.page;
    const cdp=await s.context.newCDPSession(p);
    const entry={run,samples:[]};report.memory_profile.runs.push(entry);
    async function sample(name,{pending=false}={}){
      if(!pending)await until(p,()=>globalThis.__visualMemory.snapshot().counts.pending_set_data===0,'profile scene work settled');
      const value=await memorySample(cdp,p,name);entry.samples.push(value);await saveReport();return value;
    }
    const cold=await sample('cold-scene');
    assert.equal(cold.map.floor_id,home);
    assert(cold.map.root.unique_geometries>0 && cold.map.renderer_memory?.geometries>0,'Real live CPU and renderer geometry counters');
    for(const record of targets)await select(p,record.id);
    const warm=await sample('warm-selection');
    assert.equal(warm.map.generation,cold.map.generation,'Selection uses the existing scene generation');
    assert.equal(warm.map.root.unique_geometries,cold.map.root.unique_geometries,'Selection does not grow unique geometries');
    const alternate=fixture.floors.find(item=>item.id!==home);
    for(let cycle=0;cycle<memoryCycles;cycle++){
      await p.locator('[data-floor='+JSON.stringify(alternate.id)+']').click();await mapReady(p);
      await p.locator('[data-floor='+JSON.stringify(home)+']').click();await mapReady(p);
      const value=await sample('rebuild-return-'+cycle);
      assert.equal(value.map.floor_id,home);
      assert.equal(value.map.root.unique_geometries,cold.map.root.unique_geometries,'Returning to the same data keeps the live geometry count bounded');
    }
    const gate=assetGate(alternate.model_id);gates.add(gate);s.control.gate=gate;
    let timeout;
    try{
      await p.locator('[data-floor='+JSON.stringify(alternate.id)+']').click();
      await Promise.race([gate.requested,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Profile stale-load gate not reached')),15000);})]);
      await p.locator('[data-floor='+JSON.stringify(home)+']').click();await mapReady(p);
      const pending=await sample('stale-load-held',{pending:true});
      assert(pending.counts.pending_set_data>=1,'A genuine superseded load remains in flight');
    }finally{clearTimeout(timeout);gate.release();gates.delete(gate);delete s.control.gate;}
    await mapReady(p);const stale=await sample('stale-load-released');
    assert.equal(stale.map.floor_id,home,'Late completion cannot replace the current floor');
    assert(stale.counts.superseded_completions>=1,'Profiler observed a superseded build completion');
    assert.equal(stale.map.root.unique_geometries,cold.map.root.unique_geometries);
    await select(p,targets[0].id);await enterEdit(p);
    await p.locator('.exhibit-transform > summary').click();
    const position=p.locator('[data-group-vector][data-vector=position][data-axis="0"]');
    const original=Number(await position.inputValue());
    await position.fill(String(original+1));await position.press('Tab');await mapReady(p);
    await sample('edit-rebuild');
    await p.locator('[data-action=undo]').click();await mapReady(p);
    assert.equal(Number(await position.inputValue()),original);await sample('undo-rebuild');
    await p.locator('[data-action=cancelEdit]').click();await mapReady(p);
    await p.setViewportSize({width:1100,height:780});await advance(p,1200);await sample('resized');
    await p.setViewportSize(viewport);await advance(p,1200);await sample('resize-return');
    await p.evaluate(()=>globalThis.__visualMemory.destroy());await advance(p,80);
    await sample('renderer-destroyed');
    await p.goto(TEST_ORIGIN+'/accessibility.html',{waitUntil:'domcontentloaded'});
    await until(p,()=>document.fonts.status==='loaded','post-navigation fonts');
    entry.samples.push(await memorySample(cdp,p,'after-document-navigation'));
    await cdp.detach();await done(s);await saveReport();
  }
}

try {
  await saveReport();
  report.environment.php=execFileSync(php,['-v'],{encoding:'utf8'}).split('\n')[0];
  report.environment.python=execFileSync(python,['--version'],{encoding:'utf8'}).trim();
  report.stage=pythonJSON(['stage','--source',source,'--data',data,'--profile',profile,'--php',php,'--seed',seed]);
  report.input_fingerprint=report.stage.original.code.sha256;
  await saveReport();
  const modules=[process.env.PLAYWRIGHT_MODULE,'playwright','playwright-core',
    '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright-core',
    '/Users/nreigs/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'].filter(Boolean);
  let playwright;
  for(const module of modules) {try {playwright=require(module);report.playwright_version=require(module+'/package.json').version;break;}catch{}}
  if(!playwright)throw Error('Install Playwright or set PLAYWRIGHT_MODULE to a playwright-core directory');
  const executable=option('--browser',process.env.CHROME_PATH);
  const launchOptions={headless:true,args};
  if(executable)launchOptions.executablePath=executable;
  else if(process.platform==='darwin')launchOptions.executablePath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  report.browser_executable=launchOptions.executablePath||'Playwright bundled Chromium';
  browser=await playwright.chromium.launch(launchOptions);report.browser_version=browser.version();
  const snapshot=JSON.parse((await phpGet(path.join(report.stage.root,'WebApp'),'',php)).body.toString());
  const generated=new Set(report.stage.fixture?.exhibits.map(exhibit=>exhibit.id)||[]);
  const usable=snapshot.exhibits.find(exhibit=>exhibit.placed && exhibit.models.length && !generated.has(exhibit.id));
  assert(usable || memoryOnly,'Source scenarios require a placed exhibit with hardware; matrix fixtures do not replace source data coverage');
  scenarioPlan=usable?{floorId:usable.floorId,exhibitId:usable.id}:{floorId:report.stage.fixture.home_floor};
  report.scenario_plan=scenarioPlan;
  report.dataset_summary={floors:snapshot.floors.length,exhibits:snapshot.exhibits.length,assets:snapshot.assets.length};
  if(memoryOnly)await memoryStates();
  else{await coreScenes();await uiStates();await cameraFrames();await mobileStates();await accessibilityStates();await matrixStates();}
  const after=pythonJSON(['fingerprint','--source',source,'--data',data]);
  for(const key of ['code','assets','exhibits'])assert.equal(after[key].sha256,report.stage.original[key].sha256,'Input source/data unchanged: '+key);
  report.assertions.push('All browser state assertions passed','All transport requests GET-only and successful','No uncaught page or console errors','Source and input data unchanged');
  report.complete=true;
} catch(error) {report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;console.error(error.message);}
finally {
  for(const gate of gates)gate.release();
  for(const context of active)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  report.finished=new Date().toISOString();await saveReport();
  console.log(JSON.stringify({complete:report.complete,frames:report.frames.length,report:path.join(output,'run.json'),failure:report.failure?.message}));
}
