#!/usr/bin/env node
// 开发模式：启动服务，并在 server/ shared/ config/ 变化时自动重启。前端文件无需重启（刷新即可）。

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let child = null;
let timer = null;

function start() {
  child = spawn(process.execPath, [resolve(root, 'server/index.js'), ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && code) console.log(`[dev] 服务退出（代码 ${code}），修改文件后会自动重启`);
  });
}

function restart(file) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\n[dev] ${file} 已修改，重启服务…`);
    if (child && child.exitCode === null) {
      child.once('exit', start);
      child.kill('SIGTERM');
    } else start();
  }, 150);
}

for (const dir of ['server', 'shared', 'config']) {
  watch(resolve(root, dir), { recursive: true }, (_, file) => file && !file.endsWith('.tmp') && restart(`${dir}/${file}`));
}
process.on('SIGINT', () => {
  child?.kill('SIGTERM');
  process.exit(0);
});
start();
