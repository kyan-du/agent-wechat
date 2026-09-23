#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const productionPath = join(root, 'scripts/download-wechat.sh');
const production = readFileSync(productionPath, 'utf8');
const ARM64_URL = 'https://web.archive.org/web/20260923032446if_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb';
const ARM64_SHA = '51784a262c725ef1595dd833f456190e913583dd81c24dd8fe587532bc91c0dc';
const AMD64_URL = 'https://web.archive.org/web/20260921152423if_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb';
const AMD64_SHA = 'b7d0f8d53e9f648bc2c77a6096a04100d008f2d9f0d3988a2a4859b5992aca0a';
const count = (haystack, needle) => haystack.split(needle).length - 1;
assert.equal(count(production, ARM64_URL), 1, 'production arm64 URL must occur exactly once');
assert.equal(count(production, ARM64_SHA), 1, 'production arm64 hash must occur exactly once');
assert.equal(count(production, AMD64_URL), 1, 'production amd64 URL must occur exactly once');
assert.equal(count(production, AMD64_SHA), 1, 'production amd64 hash must occur exactly once');
assert.equal(count(production, '4.1.13.23'), 3, 'production WeChat version pin drifted');
assert.ok(production.includes('--max-redirs 0'));
assert.ok(production.includes('[ "$http_code" != "200" ]'));

// Small synthetic fixture. This is not a WeChat package and must not be treated as one.
const fixtureBody = Buffer.from('agent-wechat-download-fixture-v1\n');
const fixtureHash = createHash('sha256').update(fixtureBody).digest('hex');
const wrongBody = Buffer.from('agent-wechat-download-fixture-wrong-hash\n');

const serverSource = `import { writeSync } from 'node:fs';
import { createServer } from 'node:http';
const mode = process.env.FIXTURE_MODE;
const correct = Buffer.from(process.env.FIXTURE_BODY_B64, 'base64');
const wrong = Buffer.from(process.env.WRONG_BODY_B64, 'base64');
const server = createServer((req, res) => {
  const port = server.address().port;
  if (mode === 'redirect' && req.url === '/WeChatLinux_arm64.deb') {
    res.writeHead(302, { Location: 'http://127.0.0.1:' + port + '/actual.deb' });
    res.end('redirect-body');
    return;
  }
  const payload = mode === 'wrong-hash' ? wrong : correct;
  if (req.url === '/WeChatLinux_arm64.deb' || req.url === '/actual.deb') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(payload.length),
    });
    res.end(payload);
    return;
  }
  res.writeHead(404);
  res.end();
});
process.on('SIGTERM', () => process.exit(0));
server.listen(0, '127.0.0.1', () => {
  writeSync(1, 'PORT=' + server.address().port + '\\n');
});
`;

function localEnv(dir) {
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` };
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
    delete env[key];
  }
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

async function startHttpServer(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-http-'));
  const file = join(dir, 'server.mjs');
  writeFileSync(file, serverSource);
  const child = spawn(process.execPath, [file], {
    env: {
      ...process.env,
      FIXTURE_MODE: mode,
      FIXTURE_BODY_B64: fixtureBody.toString('base64'),
      WRONG_BODY_B64: wrongBody.toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`HTTP fixture server did not publish a port: ${stderr}`)), 5000);
      const finish = (err, value) => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        if (err) reject(err);
        else resolve(value);
      };
      const onData = (chunk) => {
        buf += chunk;
        const match = buf.match(/^PORT=(\d+)/m);
        if (match) finish(null, Number(match[1]));
      };
      const onError = (err) => finish(err);
      const onExit = (code) => finish(new Error(`HTTP fixture server exited before listen (${code}): ${stderr}`));
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    return {
      child,
      dir,
      port,
      url: `http://127.0.0.1:${port}/WeChatLinux_arm64.deb`,
    };
  } catch (err) {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function stopHttpServer(server) {
  if (!server) return;
  try {
    server.child.kill('SIGTERM');
  } catch {
    // already exited
  }
  rmSync(server.dir, { recursive: true, force: true });
}

function isolateDownloader(url, sha) {
  const d = mkdtempSync(join(tmpdir(), 'wechat-download-'));
  mkdirSync(join(d, 'scripts'));
  mkdirSync(join(d, 'docker'));
  assert.equal(count(production, ARM64_URL), 1);
  assert.equal(count(production, ARM64_SHA), 1);
  let script = production.replace(ARM64_URL, url);
  script = script.replace(ARM64_SHA, sha);
  assert.equal(count(script, ARM64_URL), 0, 'isolated copy still points at production WeChat URL');
  assert.equal(count(script, url), 1, 'fixture URL must replace the production pin exactly once');
  assert.equal(count(script, ARM64_SHA), 0, 'isolated copy still pins the production WeChat hash');
  assert.equal(count(script, sha), 1, 'fixture hash must replace the production pin exactly once');
  assert.ok(script.includes(AMD64_URL), 'amd64 production URL must remain in the isolated copy');
  assert.ok(script.includes(AMD64_SHA), 'amd64 production hash must remain in the isolated copy');
  assert.ok(script.includes('test "$(dpkg-deb -f "$1" Version)" = 4.1.13.23'));
  assert.ok(script.includes('--max-redirs 0'));
  writeFileSync(join(d, 'scripts/download-wechat.sh'), script);
  const bin = join(d, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho arm64\n');
  chmodSync(join(bin, 'uname'), 0o755);
  writeFileSync(
    join(bin, 'dpkg-deb'),
    `#!/bin/sh
case "$3" in
  Package) echo wechat ;;
  Version) echo 4.1.13.23 ;;
  Architecture) echo arm64 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, 'dpkg-deb'), 0o755);
  return d;
}

function leftovers(dir) {
  return {
    final: existsSync(join(dir, 'docker/wechat.deb')),
    partial: existsSync(join(dir, 'docker/wechat.deb.partial')),
  };
}

function runDownload(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['scripts/download-wechat.sh'], {
      cwd: dir,
      env: localEnv(dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('download-wechat.sh timed out'));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function withServer(mode, fn) {
  const server = await startHttpServer(mode);
  let dir;
  try {
    dir = isolateDownloader(server.url, fixtureHash);
    return await fn(server, dir);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    stopHttpServer(server);
  }
}

await withServer('redirect', async (_server, dir) => {
  const result = await runDownload(dir);
  assert.notEqual(result.status, 0, '302 to the correct fixture payload must be rejected');
  const files = leftovers(dir);
  assert.equal(files.final, false, '302 rejection left docker/wechat.deb');
  assert.equal(files.partial, false, '302 rejection left docker/wechat.deb.partial');
});

await withServer('wrong-hash', async (_server, dir) => {
  const result = await runDownload(dir);
  assert.notEqual(result.status, 0, 'HTTP 200 with the wrong hash must be rejected');
  const files = leftovers(dir);
  assert.equal(files.final, false, 'wrong-hash rejection left docker/wechat.deb');
  assert.equal(files.partial, false, 'wrong-hash rejection left docker/wechat.deb.partial');
});

await withServer('ok', async (_server, dir) => {
  const result = await runDownload(dir);
  assert.equal(result.status, 0, `HTTP 200 fixture download failed: ${result.stdout}\n${result.stderr}`);
  const files = leftovers(dir);
  assert.equal(files.final, true, 'successful fixture download did not write docker/wechat.deb');
  assert.equal(files.partial, false, 'successful fixture download left docker/wechat.deb.partial');
  assert.deepEqual(readFileSync(join(dir, 'docker/wechat.deb')), fixtureBody);
});

assert.equal(readFileSync(productionPath, 'utf8'), production, 'production download-wechat.sh must stay unchanged');
console.log('download-wechat.sh fixture HTTP cases: 302 reject, 200 wrong-hash reject, 200 success; no leftover final/partial on failure.');
