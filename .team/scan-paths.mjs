
const base='http://127.0.0.1:5173';
const urls=['/','/js/main.js','/js/util/dom.js','/js/render/SvgRenderer.js','/js/ui/Lobby.js','/css/theme.css','/css/layout.css','/css/components.css'];
for(const u of urls){const t=await (await fetch(base+u)).text();
  const hits=[...t.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*['"]?([^'")]+)['"]?\s*\)|fetch\(\s*['"]([^'"]+)['"]|loadArt\(\s*['"]([^'"]+)['"]/g)]
    .map(m=>m[1]||m[2]||m[3]||m[4]).filter(Boolean);
  const uniq=[...new Set(hits)];
  console.log('=== '+u);
  for(const h of uniq) console.log('   '+h);
}
