/** Isolated, hand-authored demo conversations backed by real native session files and engine snapshots. */
import { mkdir, writeFile, symlink, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
const require = createRequire(import.meta.url);
const root = resolve(process.argv[2] ?? '/tmp/filesnap-demo');
const modules = process.env.DSH_DEMO_MODULES;
const binary = process.env.FILESNAP_BIN ?? resolve(import.meta.dirname, '../../../filesnap/target/release/filesnap');
if (!modules) throw new Error('Set DSH_DEMO_MODULES to an installed web profile node_modules directory.');
try { await access(root); throw new Error(`Demo directory already exists: ${root}. Choose a fresh directory.`); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const project = join(root, 'whale-shop'), data = join(root, 'snapshots');
const profile = join(root, 'home/profiles/web');
await mkdir(profile, { recursive: true });
await symlink(resolve(modules), join(profile, 'node_modules'), 'dir');
await writeFile(join(profile, 'package.json'), JSON.stringify({ name:'filesnap-screenshot-demo', private:true, dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-filesnap'],patchReload:'live'}} }, null, 2));
await writeFile(join(profile,'cordis.patch.yml'), `- id: hmr\n  disabled: false\n  config:\n    root: []\n    usePolling: true\n    interval: 400\n- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(root,'sessions'))}\n- id: storage-json\n  config:\n    root: ${JSON.stringify(join(root,'storages'))}\n- id: filesnap\n  config:\n    command: ${JSON.stringify(binary)}\n    dataDir: ${JSON.stringify(data)}\n    autoMigrate: false\n- id: agent-presets\n  config:\n    default: standard\n    includeUserRoot: false\n`);
const ctx = new Context();
const fibers = [await ctx.plugin(SessionStore), await ctx.plugin(JsonlSessionPersistence, {root:join(root,'sessions')})];
async function file(cwd,name,text) { await mkdir(dirname(join(cwd,name)),{recursive:true}); await writeFile(join(cwd,name),text); }
function declare(cwd,id,turn,paths) {
 const run=spawnSync(binary,['--data-dir',data,'declare','--session',id,'--turn',`${id}.t${turn}`,'--cwd',cwd,...paths.flatMap(p=>['--path',join(cwd,p)])],{encoding:'utf8'});
 if(run.error || run.status!==0) throw new Error(run.error?.message ?? run.stderr);
}
function capture(cwd,id,turn) {
 const run=spawnSync(binary,['--data-dir',data,'capture','--session',id,'--turn',`${id}.t${turn}`,'--cwd',cwd],{encoding:'utf8'});
 if(run.error || run.status!==0) throw new Error(run.error?.message ?? run.stderr);
}
async function demo(cwd,id,title) {
 await file(cwd,'src/cart.ts','export const total = (prices: number[]) => prices.reduce((a, b) => a + b, 0);\n');
 await file(cwd,'README.md','# Whale Shop\nA small checkout demo.\n');
 const session=ctx.sessions.create(SessionId(id),{meta:{cwd}});
 const prompts=['给购物车增加运费计算：满 99 元包邮，否则运费 8 元。','增加会员折扣，并把价格计算拆分成独立模块。','先撤掉会员折扣，保留上一轮稳定的购物车实现。'];
 const answers=['已实现运费规则，并补充了购物车测试。当前总价由商品金额和运费组成。','已新增 `src/pricing.ts`，将会员折扣接入购物车，同时新增会员价格测试。\n\n如果这次拆分不合适，可以回退到这一轮开始前的文件状态。','可以使用上一条消息下方的回退按钮，先查看将恢复和删除的文件，再确认。原对话会保留，之后也可以用 `/redo` 撤销回退。'];
 for(let turn=1;turn<=3;turn++) {
  capture(cwd,id,turn);
  session.append('turn/start',{turn});
  session.append('user/message',createUserMessage({content:[{type:'text',text:prompts[turn-1]}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('step/start',{turn,step:1});
  if(turn===1) {
   declare(cwd,id,turn,['src/cart.ts','tests/cart.test.ts']);
   await file(cwd,'src/cart.ts','export const total = (subtotal: number) => subtotal + (subtotal >= 99 ? 0 : 8);\n');
   await file(cwd,'tests/cart.test.ts',"import { total } from '../src/cart';\nconsole.assert(total(99) === 99);\nconsole.assert(total(50) === 58);\n");
  }
  if(turn===2) {
   declare(cwd,id,turn,['src/cart.ts','src/pricing.ts','tests/member.test.ts']);
   await file(cwd,'src/pricing.ts','export const memberPrice = (price: number) => price * 0.9;\n');
   await file(cwd,'src/cart.ts',"import { memberPrice } from './pricing';\nexport const total = (subtotal: number) => memberPrice(subtotal) + (subtotal >= 99 ? 0 : 8);\n");
   await file(cwd,'tests/member.test.ts',"import { memberPrice } from '../src/pricing';\nconsole.assert(memberPrice(100) === 90);\n");
  }
  session.append('assistant/message',{turn,step:1,message:createAssistantMessage({content:[{type:'text',text:answers[turn-1]}],source:{provider:'deepseek',model:'deepseek-v4-flash'}})},{surfaceOp:'append'});
  session.append('step/end',{turn,step:1});
  session.append('turn/end',{turn,reason:{kind:'completed'}});
 }
 session.append('session/title',{title,messageSeqs:[],source:{kind:'user'}});
 await ctx.sessions.flush(session);
 return session;
}
try {
 const legacy = ctx.sessions.create(SessionId('session-filesnap-demo-legacy'),{meta:{cwd:project}});
 legacy.append('session/title',{title:'↩ 旧版分支标记迁移演示',messageSeqs:[],source:{kind:'user'}});
 await ctx.sessions.flush(legacy);
 await demo(project,'session-filesnap-demo-shop','购物车 · 运费与会员折扣');
 const recovery = await demo(join(root,'recovery-workspace'),'session-filesnap-demo-recovery','中断恢复演示');
 const boundary = recovery.snapshotEvents().find(e=>e.type==='turn/end').seq;
 const child = ctx.sessions.fork(recovery,boundary,SessionId('session-filesnap-demo-recovered'));
 child.append('session/title',{title:'中断恢复 · 待完成分支',messageSeqs:[],source:{kind:'user'}});
 await ctx.sessions.flush(child);
} finally { for(const f of fibers.reverse()) await f.dispose(); }
const crash = spawnSync(process.execPath,[join(import.meta.dirname,'interrupt.mjs'),binary,data,join(root,'recovery-workspace')],{encoding:'utf8'});
if(crash.error || crash.status!==86) throw new Error(crash.error?.message ?? crash.stderr);
await writeFile(join(root,'demo.json'),JSON.stringify({root,project,data,binary,version:require('../../package.json').version},null,2));
console.log(`Seeded ${root}\nDSH_HOME=${join(root,'home')}\nRun DSH with cwd ${project}, --profile web --port 7789 --no-open`);
