import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const out=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
const meta=JSON.parse(await readFile(path.join(out,'build-meta.json'),'utf8'));
async function files(dir){const result=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.name.endsWith('.html'))result.push(p);}return result;}
const editions=JSON.parse(await readFile(path.join(out,'versions.json'),'utf8'));
const expectedPages=editions.reduce((count,edition)=>count+edition.pages.length*2,0);
assert(editions.some(edition=>edition.id==='main'));
assert.equal(new Set(editions.map(edition=>edition.id)).size,editions.length);
const htmls=await files(out),failures=[];let localized=0;
for(const file of htmls){const html=await readFile(file,'utf8');const relative=path.relative(out,file);const url=new URL(meta.base+relative.replace(/index.html$/,''),meta.siteUrl);const isPage=/^(?:versions\/[^/]+\/)?(en|zh)\//.test(relative);if(isPage){localized++;assert(html.includes('class="version-switcher"'),relative);assert(html.includes('class="edition-notice"'),relative);assert(html.includes('rel="canonical"'),relative);assert(html.includes('hreflang="zh-CN"')&&html.includes('hreflang="en"'),relative);assert(html.includes('name="description"'),relative);const scripts=[...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];scripts.forEach(m=>JSON.parse(m[1]));const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,relative+' duplicate IDs');}
 for(const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)){const value=match[1].replace(/&amp;/g,'&');const target=new URL(value,url);if(target.origin!==url.origin||!target.pathname.startsWith(meta.base))continue;let location=path.join(out,decodeURIComponent(target.pathname.slice(meta.base.length)));try{if((await stat(location)).isDirectory())location=path.join(location,'index.html');await stat(location);if(target.hash&&location.endsWith('.html')){const targetHTML=await readFile(location,'utf8');const id=decodeURIComponent(target.hash.slice(1));if(!targetHTML.includes(`id="${id}"`))failures.push(`${relative}: missing anchor ${value}`);}}catch{failures.push(`${relative}: missing ${value}`);}}
}
assert.equal(localized,expectedPages);assert.equal(meta.pages,expectedPages);assert.equal(meta.editions,editions.length);
for(const edition of editions){
 const prefix=edition.id==='main'?'':`versions/${edition.version}/`;
 for(const lang of ['en','zh']){
  const data=JSON.parse(await readFile(path.join(out,prefix,`search-${lang}.json`),'utf8'));
  assert.equal(data.pages.length,edition.pages.length);
  assert(data.pages.every(p=>p.url.startsWith(meta.base+prefix+lang+'/')),'search must stay within the selected version and language');
  const home=await readFile(path.join(out,prefix,lang,'index.html'),'utf8');
  if(edition.ref){assert(home.includes(edition.version));assert.match(edition.commit,/^[a-f0-9]{40}$/);assert(home.includes('/blob/'+edition.commit+'/'),'archived source links must be pinned');}
  for(const slug of edition.pages){
   const html=await readFile(path.join(out,prefix,lang,slug,'index.html'),'utf8');
   const menu=html.match(/<details class="version-switcher">(.*?)<\/details>/s)?.[1];
   assert(menu,'version menu');
   assert.equal([...menu.matchAll(/aria-current="true"/g)].length,1,'one selected edition');
   for(const target of editions){
    const targetPrefix=target.id==='main'?'':`versions/${target.version}/`;
    const targetSlug=slug&&target.pages.includes(slug)?slug+'/':'';
    assert(menu.includes(`href="${meta.base}${targetPrefix}${lang}/${targetSlug}"`),'preserve language and available chapter, otherwise go to overview');
   }
  }
 }
}
const sitemap=await readFile(path.join(out,'sitemap.xml'),'utf8');assert.equal([...sitemap.matchAll(/<loc>/g)].length,expectedPages);
assert.deepEqual(failures,[]);console.log(`Site checks passed: ${expectedPages} localized pages in ${editions.length} editions, version navigation, links and anchors, isolated search indexes, metadata and sitemap.`);
