// 扫描 download/ 目录，生成 files.json 清单（index.html 的兜底数据源）
// 用法: node scan-downloads.mjs
import { readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const downloadDir = path.join(root, "download");

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

const entries = await readdir(downloadDir, { withFileTypes: true });
const files = [];
for (const entry of entries) {
  if (!entry.isFile() || entry.name.startsWith(".")) continue;
  const full = path.join(downloadDir, entry.name);
  const info = await stat(full);
  files.push({
    name: entry.name,
    size: info.size,
    mtime: info.mtime.toISOString(),
    sha256: await sha256(full)
  });
}
files.sort((a, b) => b.mtime.localeCompare(a.mtime));

await writeFile(
  path.join(root, "files.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + "\n",
  "utf8"
);
console.log(`files.json 已更新: ${files.length} 个文件`);
