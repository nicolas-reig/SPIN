#!/usr/bin/env node
/** Real browser/app frames, synthetic transport only. Does not open a listening socket. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { installTransport, phpGet, TEST_ORIGIN } from './transport.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const input = process.argv.slice(2);
function option(name, fallback) {const index=input.indexOf(name); return index<0 ? fallback : input[index+1];}
const source = path.resolve(option('--source', path.join(here,'../..')));
const data = path.resolve(option('--data', path.dirname(source)));
const output = path.resolve(option('--output', path.join(here,'artifacts/run')));
const profile = option('--profile','source');
assert(['source','matrix'].includes(profile), '--profile must be source or matrix');
const python = option('--python',process.env.PYTHON || 'python3');
const php = option('--php',process.env.PHP || 'php');
const backend = option('--backend','webgl');
assert(['webgl','webgpu'].includes(backend), '--backend must be webgl or webgpu');
const epoch = '2026-11-12T12:00:00.000Z';
const viewport = {width:1440,height:1000};
const args = ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--force-color-profile=srgb'];
if (backend === 'webgpu') args.push('--enable-unsafe-webgpu');
const report = {complete:false, started:new Date().toISOString(), source, data, profile, backend,
  viewport, device_scale_factor:1, clock_epoch:epoch, browser_arguments:args,
  environment:{platform:os.platform(),release:os.release(),arch:os.arch(),node:process.version,
    php:execFileSync(php,['-v'],{encoding:'utf8'}).split('\n')[0],
    python:execFileSync(python,['--version'],{encoding:'utf8'}).trim()}, frames:[], assertions:[], contexts:[]};
let browser;
let contextSerial=0;
const active = new Set();
await mkdir(output,{recursive:true});
async function saveReport() {await writeFile(path.join(output,'run.json'), JSON.stringify(report,null,2)+'\n');}
function pythonJSON(command) {return JSON.parse(execFileSync(python,[path.join(here,'fixture.py'), ...command],{encoding:'utf8',maxBuffer:32*1024*1024}));}
async function advance(page,ms=400) {await page.clock.runFor(ms); await page.waitForTimeout(25);}
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
async function fresh(params='', {palette='default',mobile=false,accessibility=false,unavailable=false}={}) {
  const audit={name:'context-'+(++contextSerial),requests:[],blockedWrites:[],errors:[],pageErrors:[],consoleErrors:[]};
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:viewport,deviceScaleFactor:1,locale:'de-DE',timezoneId:'UTC',colorScheme:'light',reducedMotion:'no-preference',serviceWorkers:'block'});
  active.add(context); report.contexts.push(audit);
  await installTransport(context,path.join(report.stage.root,'WebApp'),audit,php);
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
  const target=accessibility?'accessibility.html?return=%2Findex.html':'index.html?'+[suffix,params].filter(Boolean).join('&');
  await page.goto(TEST_ORIGIN+'/'+target,{waitUntil:'domcontentloaded'});
  await until(page,()=>document.fonts.status==='loaded','fonts loaded');
  if(accessibility) await until(page,()=>document.querySelectorAll('.palette-option').length===5,'palette cards');
  else {
    await until(page,()=>document.querySelector('[data-select]'),'exhibits loaded');
    if(mobile) await page.locator('[data-action="view:map"]').click();
    if(unavailable) await until(page,()=>Boolean(document.querySelector('#map-message')?.textContent),'map unavailable message');
    else await mapReady(page);
  }
  return {page,context,audit};
}
async function done(session) {
  const {audit,context}=session;
  assert.deepEqual(audit.blockedWrites,[], 'No persisted writes in visual scenarios');
  assert.deepEqual(audit.errors,[], 'No failed transport requests');
  assert.deepEqual(audit.pageErrors,[], 'No uncaught page errors');
  assert.deepEqual(audit.consoleErrors,[], 'No browser console errors');
  await context.close();active.delete(context);
}
async function frame(page,name,{map=true,wait=600}={}) {
  assert(!report.frames.some(frame=>frame.name===name),'Unique frame name '+name);
  if(wait) await advance(page,wait);
  const canvas=map?await page.locator('#map-canvas canvas').boundingBox():null;
  if(map) assert(canvas && canvas.width>100 && canvas.height>100, 'Visible canvas '+name);
  const metadata=await page.evaluate(()=>({url:location.pathname+location.search,view:document.body.dataset.view,
    colorMode:document.documentElement.dataset.colorMode,selected:document.querySelector('.exhibit-row[aria-pressed="true"]')?.dataset.select||null,
    floor:document.querySelector('[data-floor][aria-current="true"]')?.dataset.floor||null,
    editing:document.body.classList.contains('editing'),canvasState:{...document.querySelector('#map-canvas canvas')?.dataset},
    viewport:{width:innerWidth,height:innerHeight},heading:document.querySelector('#inspector h1')?.textContent||null,
    openDialog:Boolean(document.querySelector('dialog[open]')),openMenus:document.querySelectorAll('.floating-popover,.selection-menu,.status-menu[aria-hidden="false"]').length}));
  const file=name+'.png';
  await page.screenshot({path:path.join(output,file),animations:'allow',caret:'hide',scale:'css',fullPage:false});
  report.frames.push({name,file,canvas,...metadata});
  await saveReport();
}
async function repeats(page,name) {
  await frame(page,name+'-settled-0');
  await frame(page,name+'-settled-500ms',{wait:500});
  await frame(page,name+'-settled-2000ms',{wait:1500});
}
async function select(page,id) {
  const locator=page.locator('[data-select='+JSON.stringify(id)+']');
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
    const id=await p.locator('[data-select]').first().getAttribute('data-select');
    await p.locator('[data-select]').first().hover();await frame(p,'source-'+style+'-list-hover');
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
  const id=await p.locator('[data-select]').first().getAttribute('data-select');await select(p,id);
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
  const id=await p.locator('[data-select]').first().getAttribute('data-select');
  // Clock is paused; exact app RAF times remain fixed even while screenshots encode.
  await p.locator('[data-select='+JSON.stringify(id)+']').click();
  await frame(p,'camera-select-000ms',{wait:0});
  await frame(p,'camera-select-064ms',{wait:64});
  await frame(p,'camera-select-128ms',{wait:64});
  await frame(p,'camera-select-256ms',{wait:128});
  await frame(p,'camera-select-1256ms',{wait:1000});
  // Selection only reframes hidden exhibits; an already-visible one may keep its camera.
  assert.equal(await p.locator('[data-select='+JSON.stringify(id)+']').getAttribute('aria-pressed'),'true');
  await command(p,'perspective');await mapReady(p,'perspective');
  const beforeTurn=await p.locator('#map-canvas canvas').getAttribute('data-camera-offset');
  await command(p,'turnRight');await frame(p,'camera-explicit-turn');
  assert.notEqual(await p.locator('#map-canvas canvas').getAttribute('data-camera-offset'),beforeTurn,'Explicit perspective turn changes camera');
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
  await p.locator('[data-select]').first().click();await advance(p,1200);
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
  const s=await fresh('view=top');const p=s.page;
  for(const status of ['ok','problem','retired']) {
    await select(p,'Visual '+status);await frame(p,'matrix-status-'+status);
    assert.equal(await p.locator('.status-choice[aria-checked=true]').getAttribute('data-status-choice'),status);
  }
  for(const floor of ['1','-1','0']) {
    await p.locator('[data-floor="'+floor+'"]').click();await mapReady(p);await frame(p,'matrix-floor-'+(floor==='-1'?'minus1':floor));
    assert.equal(await p.locator('[data-floor="'+floor+'"]').getAttribute('aria-current'),'true');
  }
  // Keyboard floor navigation and a rapid switch exercise stale generation handling.
  await p.locator('[data-floor="0"]').focus();await p.keyboard.press('Home');await mapReady(p);await frame(p,'matrix-floor-keyboard');
  await p.locator('[data-floor="-1"]').click();await p.locator('[data-floor="1"]').click();await p.locator('[data-floor="0"]').click();
  await mapReady(p);await frame(p,'matrix-floor-rapid-return');
  await select(p,'Visual ok');await frame(p,'matrix-post-rich-content');
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
  await p.locator('[data-select="Visual problem"]').click({modifiers:['Shift']});await frame(p,'matrix-edit-multiselect');
  assert.equal(await p.locator('.exhibit-row[aria-pressed=true]').count(),2);
  await done(s);
}

try {
  report.stage=pythonJSON(['stage','--source',source,'--data',data,'--profile',profile]);
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
  report.snapshot = JSON.parse((await phpGet(path.join(report.stage.root,'WebApp'),'',php)).body.toString());
  // Avoid persisting content bodies a second time in the report.
  report.dataset_summary={floors:report.snapshot.floors.length,exhibits:report.snapshot.exhibits.length,assets:report.snapshot.assets.length};delete report.snapshot;
  await coreScenes();await uiStates();await cameraFrames();await mobileStates();await accessibilityStates();await matrixStates();
  const after=pythonJSON(['fingerprint','--source',source,'--data',data]);
  for(const key of ['code','assets','exhibits'])assert.equal(after[key].sha256,report.stage.original[key].sha256,'Input source/data unchanged: '+key);
  report.assertions.push('All browser state assertions passed','All transport requests GET-only and successful','No uncaught page or console errors','Source and input data unchanged');
  report.complete=true;
} catch(error) {report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;console.error(error.message);}
finally {
  for(const context of active)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  report.finished=new Date().toISOString();await saveReport();
  console.log(JSON.stringify({complete:report.complete,frames:report.frames.length,report:path.join(output,'run.json'),failure:report.failure?.message}));
}
