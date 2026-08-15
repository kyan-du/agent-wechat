#!/usr/bin/env node
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, matchesGlob, relative, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const context = join(root, 'docker');
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
function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(relative(context, full).replaceAll('\\', '/'));
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
const missing = required.filter(path => !existsSync(join(context, path)) || ignored(path));
if (missing.length) throw new Error(`required Docker context tools missing or ignored: ${missing.join(', ')}`);
const forbiddenPattern = /(^|\/)(fixtures?|captures?|screenshots|qrcodes?|secrets?|credentials?|tokens?)(\/|$)|(^|\/)(wechat\.deb|\.env(?:\..*)?|.*\.(?:db|db-wal|db-shm|sqlite|sqlite3|pem|key|p12))$|^tools\/test_/i;
const leaked = walk(context).filter(path => forbiddenPattern.test(path) && !ignored(path));
if (leaked.length) throw new Error(`forbidden Docker context paths present: ${leaked.join(', ')}`);
console.log(`Docker context validated: ${required.length} required /opt/tools sources present; forbidden local material absent.`);
