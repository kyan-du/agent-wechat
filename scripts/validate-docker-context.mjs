#!/usr/bin/env node
import {lstatSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {isAbsolute, join, matchesGlob, relative, resolve, sep} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const context = join(root, 'docker');
const realContext = realpathSync(context);
const rules = readFileSync(join(context, '.dockerignore'), 'utf8')
  .split(/\r?\n/).map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(raw => ({negated: raw.startsWith('!'), pattern: raw.replace(/^!/, '').replace(/^\//, '')}));
function ignored(path) {
  let result = false;
  for (const {negated, pattern} of rules) {
    const match = pattern.includes('/')
      ? matchesGlob(path, pattern) || matchesGlob(path, `${pattern.replace(/\/$/, '')}/**`)
      : matchesGlob(path, `**/${pattern}`) || matchesGlob(path, `**/${pattern.replace(/\/$/, '')}/**`);
    if (match) result = !negated;
  }
  return result;
}
function contained(realPath) {
  const path = relative(realContext, realPath);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const path = relative(context, full).replaceAll('\\', '/');
    const stat = lstatSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(path);
  }
  return files;
}
const required = [
  'tools/a11y-dump', 'tools/chat-select', 'tools/chat-select.py', 'tools/click',
  'tools/extract-keys', 'tools/extract-keys.py', 'tools/input', 'tools/key',
  'tools/launch-wechat', 'tools/media-convert', 'tools/media-convert.py',
  'tools/paste-file', 'tools/paste-image', 'tools/screenshot', 'tools/scroll',
  'tools/window-activate',
];
const executable = new Set(required.filter(path => !path.endsWith('.py')));
const invalid = [];
for (const path of required) {
  const full = join(context, path);
  try {
    const stat = lstatSync(full);
    const real = realpathSync(full);
    const reasons = [];
    if (ignored(path)) reasons.push('ignored');
    if (stat.isSymbolicLink()) reasons.push('symlink');
    if (!stat.isFile()) reasons.push('not a regular file');
    if (!contained(real)) reasons.push('resolves outside context');
    if (executable.has(path) && (stat.mode & 0o111) === 0) reasons.push('not executable');
    if (reasons.length) invalid.push(`${path} (${reasons.join(', ')})`);
  } catch {
    invalid.push(`${path} (missing or unresolvable)`);
  }
}
if (invalid.length) throw new Error(`required Docker context tools invalid: ${invalid.join(', ')}`);

// Complete semantic mirror of every local-material class in docker/.dockerignore.
// This deliberately evaluates all path components so an accidental negation cannot
// expose a secret directory merely because its final filename looks harmless.
function forbidden(path) {
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1);
  const hasComponent = value => parts.includes(value);
  return base === 'wechat.deb' || base.endsWith('.deb') || base.endsWith('.partial') ||
    hasComponent('cache') ||
    base === '.env' || base.startsWith('.env.') ||
    parts.some(part => /credential|secret|token/.test(part)) ||
    /\.(?:pem|key|p12|db|log)$/.test(base) || /\.db-/.test(base) || /\.sqlite/.test(base) ||
    ['screenshots', 'captures', 'fixtures', 'qr', 'qrcode', '.data'].some(hasComponent) ||
    /\.(?:screenshot|qr|qrcode)(?:\.|$)/.test(base) ||
    base === '.ds_store' || hasComponent('__pycache__') || base.endsWith('.pyc') ||
    (parts[0] === 'tools' && base.startsWith('test_')) ||
    (parts[0] === 'agent-server-rust' && parts[1] === 'target');
}
const leaked = walk(context).filter(path => forbidden(path) && !ignored(path));
if (leaked.length) throw new Error(`forbidden Docker context paths present: ${leaked.join(', ')}`);
console.log(`Docker context validated: ${required.length} required /opt/tools sources are regular and safe; forbidden local material absent.`);
