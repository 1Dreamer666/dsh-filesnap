import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageDefinitions } from './pages.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
export async function readSource(edition,file){
  return edition.commit ? git('show',`${edition.commit}:${file}`) : readFile(path.join(root,file));
}
function pagesFor(edition,has){
  return pageDefinitions.filter(p=>!p.file||['en','zh'].every(lang=>has(p.file(lang)))).map(p=>{
    if(p.slug||!edition.ref)return p;
    return {...p,file:lang=>lang==='en'?(has('README.en.md')?'README.en.md':'README.md'):(has('README.zh.md')?'README.zh.md':'README.md')};
  });
}
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const current={id:'main',version,ref:null,commit:null};
current.pages=pagesFor(current,file=>existsSync(path.join(root,file)));
export const editions=[current];
// Every published tag supplies its own Markdown and assets; old build scripts are never run.
// Resolve annotated tags to commits once, so the entire build uses a consistent revision.
const tags=git('tag','--list','v*','--sort=-version:refname').toString().trim().split('\n');
for(const ref of tags){
  if(!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(ref))continue;
  const commit=git('rev-parse',`${ref}^{commit}`).toString().trim();
  const files=git('ls-tree','-r','--name-only',commit).toString().trim().split('\n');
  if(!files.includes('package.json')||!files.includes('README.md'))continue;
  const manifest=JSON.parse(git('show',`${commit}:package.json`).toString());
  if(manifest.name!=='dsh-filesnap')continue;
  if(manifest.version!==ref.slice(1))throw new Error(`${ref} does not match package version ${manifest.version}`);
  const edition={id:ref,version:manifest.version,ref,commit,files};
  edition.pages=pagesFor(edition,file=>files.includes(file));
  editions.push(edition);
}
