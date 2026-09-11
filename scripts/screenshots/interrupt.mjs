/** Called only for the seed script's disposable recovery workspace. Real journal, intentional interruption before file writes. */
import { spawn } from 'node:child_process';
import { RecoveryManager } from '../../lib/recovery.js';
import { parseEvents } from '../../lib/cli.js';
const [binary,data,cwd] = process.argv.slice(2);
const cli={async run(args,dir,_signal,input){
 if(args[0]==='restore') process.exit(86);
 const child=spawn(binary,['--data-dir',data,...args],{cwd:dir,stdio:['pipe','pipe','pipe']});
 child.stdin.end(input);let stdout='',stderr='';
 child.stdout.on('data',b=>{stdout+=b});child.stderr.on('data',b=>{stderr+=b});
 const code=await new Promise((ok,fail)=>{child.on('error',fail);child.on('close',ok)});
 return {code,exit:code===0?'ok':'failed',...parseEvents(stdout),stderr};
}};
const manager=new RecoveryManager(data);
await manager.exclusive(cwd,canonical=>manager.begin(cli,canonical,{kind:'rewind',source:'session-filesnap-demo-recovery',destination:'session-filesnap-demo-recovered',target:'session-filesnap-demo-recovery.t2'}));
throw new Error('Expected intentional interruption');
