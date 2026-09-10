import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const out=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
const meta=JSON.parse(await readFile(path.join(out,'build-meta.json'),'utf8'));
async function files(dir){const result=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.name.endsWith('.html'))result.push(p);}return result;}
const htmls=await files(out),failures=[];let localized=0;
for(const file of htmls){const html=await readFile(file,'utf8');const relative=path.relative(out,file);const url=new URL(meta.base+relative.replace(/index.html$/,''),meta.siteUrl);const isPage=/^(en|zh)\//.test(relative);if(isPage){localized++;assert(html.includes('rel="canonical"'),relative);assert(html.includes('hreflang="zh-CN"')&&html.includes('hreflang="en"'),relative);assert(html.includes('name="description"'),relative);const scripts=[...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];scripts.forEach(m=>JSON.parse(m[1]));const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,relative+' duplicate IDs');}
 for(const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)){const value=match[1].replace(/&amp;/g,'&');const target=new URL(value,url);if(target.origin!==url.origin||!target.pathname.startsWith(meta.base))continue;let location=path.join(out,decodeURIComponent(target.pathname.slice(meta.base.length)));try{if((await stat(location)).isDirectory())location=path.join(location,'index.html');await stat(location);if(target.hash&&location.endsWith('.html')){const targetHTML=await readFile(location,'utf8');const id=decodeURIComponent(target.hash.slice(1));if(!targetHTML.includes(`id="${id}"`))failures.push(`${relative}: missing anchor ${value}`);}}catch{failures.push(`${relative}: missing ${value}`);}}
}
assert.equal(localized,20);assert.equal(meta.pages,20);
for(const lang of ['en','zh']){const data=JSON.parse(await readFile(path.join(out,`search-${lang}.json`),'utf8'));assert.equal(data.pages.length,10);assert(data.pages.some(p=>p.text.includes('/redo')));}
const sitemap=await readFile(path.join(out,'sitemap.xml'),'utf8');assert.equal([...sitemap.matchAll(/<loc>/g)].length,20);
assert.deepEqual(failures,[]);console.log('Site checks passed: 20 localized pages, links and anchors, search indexes, metadata and sitemap.');
