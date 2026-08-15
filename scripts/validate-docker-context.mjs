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
// Keep this aligned with every local-material class in docker/.dockerignore. In
// particular, credential/secret/token are filename substrings, not directories.
const forbiddenPattern = /(^|\/)(fixtures?|captures?|screenshots|qrcodes?|qr|cache|__pycache__|\.data)(\/|$)|(^|\/)[^/]*(?:credential|secret|token)[^/]*$|(^|\/)(?:wechat\.deb|\.env(?:\..*)?|[^/]*\.(?:deb|partial|db|db-wal|db-shm|sqlite|sqlite3|pem|key|p12|log|screenshot|qr|qrcode|pyc))$|^tools\/test_/i;
const leaked = walk(context).filter(path => forbiddenPattern.test(path) && !ignored(path));
if (leaked.length) throw new Error(`forbidden Docker context paths present: ${leaked.join(', ')}`);
console.log(`Docker context validated: ${required.length} required /opt/tools sources are regular and safe; forbidden local material absent.`);
