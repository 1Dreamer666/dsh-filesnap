import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const [bundle, binary, output] = process.argv.slice(2);
if (!bundle || !binary || !output) throw new Error('Usage: node scripts/compare-dedup.mjs <0.9.1/lib/index.js> <filesnap-0.4.0-binary> <results.json>');
const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(bundle),'..','package.json'),'utf8'));
assert.equal(manifest.name,'dsh-rewind-plugin');assert.equal(manifest.version,'0.9.1');
const version=spawnSync(binary,['--version'],{encoding:'utf8'});assert.equal(version.status,0);assert.equal(version.stdout.trim(),'filesnap 0.4.0');
const raw=await fs.readFile(bundle,'utf8');
const bundleHash=createHash('sha256').update(raw).digest('hex');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-dedup-exercise-'));
// Exercise the shipped snapshot module unchanged except for its host-home
// resolver. Every tested store receives an explicit root, so no default home
// path is used and no real DSH sessions are opened.
const start=raw.indexOf('// src/snapshot.ts\n');
const end=raw.indexOf('// src/rewind-marker-repair.ts\n',start);
assert(start>=0&&end>start);
const homeImport='import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";';
const original=raw.slice(start,end);assert(original.includes(homeImport));
const extracted=original.replace(homeImport,`const resolveDshHome = () => ${JSON.stringify(root)};`)+'\nexport { SnapshotStore };\n';
const mod=path.join(root,'snapshot.mjs');await fs.writeFile(mod,extracted);
const {SnapshotStore}=await import(pathToFileURL(mod));
const sha=b=>createHash('sha256').update(b).digest('hex');
const A='A'.repeat(65536), B='B'.repeat(65536), C='C'.repeat(65536);
const step=(content,opts={})=>({content,workspace:'w1',session:'s1',file:'a.txt',...opts});
const cases=[
 ['adjacent-repeat',[step(A),step(A),step(A)]],
 ['non-adjacent-A-B-A',[step(A),step(B),step(A)]],
 ['same-content-two-paths',[step(A),step(A,{file:'b.txt'})]],
 ['same-content-two-sessions',[step(A),step(A,{session:'s2'})]],
 ['same-content-two-workspaces',[step(A),step(A,{workspace:'w2',session:'s2'})]],
 ['all-unique',[step(A),step(B),step(C)]],
 ['repeat-after-store-reopen',[step(A),step(A,{reopen:true})]],
];
async function files(dir){let out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
const results=[];
for(const [name,steps] of cases){
 const base=path.join(root,name);await fs.mkdir(base,{recursive:true});
 const rewindRoot=path.join(base,'rewind-store'), data=path.join(base,'filesnap-data');
 let rewind=new SnapshotStore(rewindRoot);const entries=[];const captureEvents=[];
 for(let i=0;i<steps.length;i++){
  const x=steps[i];const cwd=path.join(base,x.workspace);await fs.mkdir(cwd,{recursive:true});const file=path.join(cwd,x.file);await fs.writeFile(file,x.content);
  // Make equal-sized successive versions observably different even on coarse clocks.
  const when=new Date(Date.now()+i*2000);await fs.utimes(file,when,when);
  const cp=spawnSync(binary,['--data-dir',data,'capture','--session',x.session,'--turn',`t${i+1}`,'--cwd',cwd],{encoding:'utf8',timeout:30000});
  assert.equal(cp.status,0,cp.stderr);captureEvents.push(cp.stdout.trim().split('\n').filter(Boolean).map(v=>JSON.parse(v)));
  if(x.reopen)rewind=new SnapshotStore(rewindRoot);
  const entry={callId:`call${i+1}`,anchorSeq:i+1,path:file,before:x.content};await rewind.recordEntry(x.session,entry);entries.push({session:x.session,entry});
 }
 const blobs=(await files(data)).filter(p=>/[/\\]blobs[/\\][a-f0-9]{2}[/\\][a-f0-9]{62}$/.test(p));
 const expected=new Set(steps.map(x=>sha(x.content)));
 assert.equal(blobs.length,expected.size);
 for(const file of blobs){const bytes=await fs.readFile(file);assert(expected.has(sha(bytes)));assert.equal(path.basename(path.dirname(file))+path.basename(file),sha(bytes));}
 const records=(await files(rewindRoot)).filter(p=>p.endsWith('.json'));
 let copies=0,refs=0,payloadBytes=0,recordBytes=0;
 for(const file of records){const bytes=await fs.readFile(file);const e=JSON.parse(bytes);recordBytes+=bytes.length;if('before' in e&&typeof e.before==='string'){copies++;payloadBytes+=Buffer.byteLength(e.before);}else if('ref' in e)refs++;}
 for(const {session,entry} of entries){const saved=JSON.parse(await fs.readFile(path.join(rewindRoot,session,String(entry.anchorSeq),entry.callId+'.json'),'utf8'));assert.equal(await rewind.resolveBefore(session,saved),entry.before);}
 const fsAll=await files(data);let total=0;for(const f of fsAll)total+=(await fs.stat(f)).size;
 const fsPayload=(await Promise.all(blobs.map(async f=>(await fs.stat(f)).size))).reduce((a,b)=>a+b,0);
 results.push({case:name,inputAssignments:steps.length,uniquePayloads:expected.size,filesnap:{contentCopies:blobs.length,payloadBytes:fsPayload,totalFileBytes:total},rewind:{contentCopies:copies,referenceRecords:refs,payloadBytes,totalFileBytes:recordBytes},payloadResolutionVerified:true,captureEvents});
}
const out={date:'2026-09-10',method:'Storage-component exercises; no DSH UI, no end-to-end restore benchmark, no timing comparison. FileSnap runs the released 0.4.0 CLI; SnapshotStore is extracted from released 0.9.1 with only its unused default-home resolver adapted. 64 KiB ASCII payloads; fresh independent stores per case; same FileSnap dataDir within each case; retained content, no forced GC. Total bytes exclude filesystem allocation and are path-dependent; headline comparison uses payload copies, not total archive size.',bundleSha256:bundleHash,binarySha256:sha(await fs.readFile(binary)),platform:process.platform,arch:process.arch,node:process.version,root,results};
await fs.writeFile(output,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(results.map(({case:name,filesnap,rewind})=>({case:name,filesnapCopies:filesnap.contentCopies,rewindCopies:rewind.contentCopies,rewindRefs:rewind.referenceRecords})),null,2));
