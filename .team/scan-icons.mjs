
const base='http://127.0.0.1:5173';
const names=['bolt','book','camera','chat','check','clock','close','coin','door','exit','eye','favicon','flag','hand','heart','keyboard','pause','pc','play','question','refresh','settings','shield','signal','sparkle','speed','target','teacher','toilet','trophy','user','warn','yen'];
const bad=[];
for(const n of names){const r=await fetch(base+'/assets/icons/'+n+'.svg'); if(!r.ok) bad.push(n+' -> '+r.status);}
console.log('icons checked:',names.length,'missing:', bad.length? bad.join(', '):'none');
const map=await (await fetch(base+'/assets/maps/default.svg')).text();
const ids=[...map.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
const refs=[...map.matchAll(/url\(#([^)]+)\)/g)].map(m=>m[1]);
const missing=[...new Set(refs)].filter(r=>!ids.includes(r)&&!/^pat-|^grad-/.test(r));
console.log('map internal url(#) refs:', [...new Set(refs)].length, 'missing:', missing.length?missing.join(','):'none');
