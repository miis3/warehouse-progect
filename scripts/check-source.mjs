import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),dist=resolve(root,'warehouse-project/site/dist');
const files=path=>readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(resolve(path,e.name)):[resolve(path,e.name)]);
for(const p of [...files(dist),...files(resolve(root,'scripts')),...files(resolve(root,'supabase/functions'))].filter(p=>/\.(m?js)$/.test(p)))execFileSync(process.execPath,['--check',p]);
for(const p of files(dist).filter(p=>/\.(html|css)$/.test(p))){
 const text=readFileSync(p,'utf8');
 const links=[...text.matchAll(/(?:src|href)=["']([^"']+)["']|url\(["']?([^)'"\s]+)["']?\)/g)].map(m=>m[1]||m[2]);
 for(const link of links){if(/^(?:https?:|data:|#)/.test(link))continue;assert.ok(!link.startsWith('/'),`Root-relative path in ${relative(root,p)}: ${link}`);assert.ok(existsSync(resolve(dirname(p),link.split(/[?#]/)[0])),`Missing asset: ${link}`);}
}
for(const file of ['warehouse-api.js','warehouse-management.js'])assert.ok(!/localStorage|sessionStorage/.test(readFileSync(resolve(dist,file),'utf8')),`Persistent browser session storage: ${file}`);
assert.match(readFileSync(resolve(root,'supabase/config.toml'),'utf8'),/verify_jwt\s*=\s*true/);
const config=readFileSync(resolve(dist,'warehouse-config.js'),'utf8');assert.ok(!/service_role|sb_secret_/.test(config));
console.log('JavaScript syntax, static asset paths, gateway verification and no browser-persisted sessions: PASS');
