import { readFile, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// Localhost is a potentially trustworthy origin for WebGPU; all requests are fulfilled, never listened for.
export const TEST_ORIGIN = 'http://localhost';
const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.woff2':'font/woff2', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.glb':'model/gltf-binary'};

export function responseMime(bytes, pathname) {
  if (bytes.subarray(0, 4).toString() === 'glTF') return 'model/gltf-binary';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes.subarray(0,4).toString() === 'RIFF') return 'image/webp';
  if (pathname.endsWith('/api.php')) return 'application/json; charset=utf-8';
  return types[path.extname(pathname)] || 'application/octet-stream';
}

export async function phpGet(appRoot, query = '', php = 'php') {
  const scratch = path.join(path.dirname(appRoot), 'php-tmp');
  await mkdir(scratch, {recursive:true});
  const {stdout, stderr} = await execute(php, ['-d', `sys_temp_dir=${scratch}`, path.join(here,'php-bridge.php'), path.join(appRoot,'frontend/api.php'), query], {
    encoding:'buffer', maxBuffer:256 * 1024 * 1024, timeout:60000, cwd:appRoot
  });
  const message = stderr.toString();
  const status = /__REVIEW_HTTP_STATUS__:(\d+)/.exec(message);
  if (!status) throw Error('PHP bridge returned no status: ' + message);
  const diagnostic = message.replace(/\n?__REVIEW_HTTP_STATUS__:\d+\n?/, '').trim();
  if (diagnostic) throw Error('PHP emitted diagnostics: ' + diagnostic);
  return {status:Number(status[1]), body:stdout, contentType:responseMime(stdout, '/api.php')};
}

export async function staticGet(appRoot, rawPath) {
  if (rawPath === '/favicon.ico') return {status:204, body:Buffer.alloc(0), contentType:'image/x-icon'};
  let relative;
  try { relative = decodeURIComponent(rawPath === '/' ? '/index.html' : rawPath); }
  catch { return {status:400, body:Buffer.from('Invalid encoding'), contentType:'text/plain'}; }
  const root = await realpath(path.join(appRoot,'frontend'));
  try {
    const target = await realpath(path.resolve(root, '.' + relative));
    if (!target.startsWith(root + path.sep)) return {status:403, body:Buffer.from('Forbidden'), contentType:'text/plain'};
    return {status:200, body:await readFile(target), contentType:responseMime(Buffer.alloc(0), target)};
  } catch { return {status:404, body:Buffer.from('Not found'), contentType:'text/plain'}; }
}

function responseGate(matches) {
  let release, entered;
  const resumed = new Promise(resolve=>{release=resolve;});
  const requested = new Promise(resolve=>{entered=resolve;});
  let used=false;
  return {release, requested,
    async beforeResponse(url) {
      if(used || !matches(url))return;
      used=true;entered();await resumed;
    }};
}

export function assetGate(id) {
  return responseGate(url=>url.pathname==='/api.php' && url.searchParams.get('action')==='asset' && url.searchParams.get('id')===id);
}

export function snapshotGate() {
  return responseGate(url=>url.pathname==='/api.php' && !url.searchParams.has('action'));
}

export async function installTransport(context, appRoot, audit, php = 'php', control = {}) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    try {
      if (url.origin !== TEST_ORIGIN) throw Error('Unexpected external request: ' + url.origin);
      if (request.method() !== 'GET') {
        audit.blockedWrites.push({method:request.method(), pathname:url.pathname});
        await route.fulfill({status:405, contentType:'application/json', body:'{"error":"testReadOnly"}'});
        return;
      }
      await control.gate?.beforeResponse(url);
      const response = url.pathname === '/api.php'
        ? await phpGet(appRoot, url.search.slice(1), php)
        : await staticGet(appRoot, url.pathname);
      audit.requests.push({pathname:url.pathname, search:url.search, status:response.status, bytes:response.body.length});
      if (response.status >= 400) audit.errors.push(`HTTP ${response.status} ${url.pathname}${url.search}`);
      await route.fulfill({...response, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    } catch (error) {
      audit.errors.push(error.message);
      await route.abort('failed');
    }
  });
}
