#!/usr/bin/env node
// 轻量检查：对所有 JS 做语法检查（node --check），并校验 JSON 配置可解析。零依赖。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'data' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(root);
let failed = 0;
for (const f of files) {
  try {
    if (extname(f) === '.js') execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    else if (extname(f) === '.json') JSON.parse(readFileSync(f, 'utf8'));
  } catch (err) {
    failed++;
    console.error(`✗ ${f.slice(root.length + 1)}\n${String(err.stderr || err.message).trim()}`);
  }
}
const checked = files.filter((f) => ['.js', '.json'].includes(extname(f))).length;
console.log(failed ? `${failed} 个文件有问题（共检查 ${checked} 个）` : `✓ ${checked} 个 JS/JSON 文件检查通过`);
process.exit(failed ? 1 : 0);
