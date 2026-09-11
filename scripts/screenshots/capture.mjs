/** Capture the actual local DSH UI. Run once against a fresh seed; never mock RPCs or alter the rendered product. */
import { captureSettings } from './settings.mjs';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root=resolve(process.argv[2]??'/tmp/filesnap-demo');
const version=require('../../package.json').version;
const output=resolve(process.argv[3]??join(import.meta.dirname,`../../assets/screenshots/v${version}`));
await mkdir(output,{recursive:true});
const url=(await readFile(join(root,'web.log'),'utf8')).match(/dsh web: (http[^\s]+)/)?.[1];
if(!url) throw new Error('Start the isolated web server and save its output to <demo>/web.log first.');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'UTC'});
const page=await context.newPage();page.setDefaultTimeout(10000);
const btn=name=>page.getByRole('button',{name,exact:true});
const editor=page.locator('[data-composer-input]');
const shot=async name=>{await page.waitForTimeout(700);await page.screenshot({path:join(output,name+'.png'),animations:'disabled'});console.log('Captured',name)};
try {
 await page.goto(url);await page.waitForTimeout(1500);
 for(const name of ['Continue','继续']) if(await btn(name).isVisible()) await btn(name).click();
 const later=page.getByRole('button',{name:/^(Configure later|稍后配置)$/});
 await later.waitFor(); await later.click();
 await page.waitForTimeout(300);
 if(await btn('Settings').isVisible()) {
  await btn('Settings').click();await btn('English').click();await page.getByText('中文',{exact:true}).click();await btn('关闭').click();
 }
 const workspace=page.locator('[role="treeitem"][aria-expanded]').filter({hasText:'whale-shop'});
 if(await workspace.getAttribute('aria-expanded')==='false') await workspace.click();
 await page.locator('[role="treeitem"][aria-selected]').filter({hasText:/whale-shop|购物车/}).first().click();
 await page.getByRole('button',{name:'回退到「增加会员折扣，并把价格计算拆分成独立模块。」之前',exact:true}).hover();
 await shot('01-turn-control');
 await editor.fill('/rewind');await page.keyboard.press('Enter');
 await page.getByText('回退到第 2 轮之前 · 增加会员折扣，并把价格计算拆分成独立模块。',{exact:true}).waitFor();
 await shot('02-rewind-menu');
 await page.getByText('回退到第 2 轮之前 · 增加会员折扣，并把价格计算拆分成独立模块。',{exact:true}).click();
 await btn('确认回退对话和文件').waitFor();
 await page.getByText(/删除 2 个文件/).waitFor();
 await shot('03-rewind-preview');
 await btn('确认回退对话和文件').click();await page.waitForTimeout(1500);
 await shot('04-active-branches');
 await editor.fill('/redo');await page.keyboard.press('Enter');
 await page.getByText('查看撤销回退的文件清单并确认',{exact:true}).click();
 await btn('确认还原到回退前').waitFor();await shot('05-redo-preview');
 await btn('取消').click();
 await btn('查看快照状态').click();await page.getByRole('heading',{name:'清理快照存储',exact:true}).waitFor();
 await shot('06-workspace-snapshots');
 await btn('清理快照存储').click();await btn('确认回收未引用数据').waitFor();
 await shot('07-cleanup-confirmation');
 await btn('取消').click();await btn('关闭').click();
 await btn('设置').click();await btn('FileSnap').click();await page.waitForTimeout(500);
 await captureSettings(page,root,shot);
 await writeFile(join(root,'browser-state.json'),JSON.stringify(await context.storageState()));
} catch(e) {await page.screenshot({path:join(root,'capture-error.png')});console.error(await page.locator('body').innerText());throw e;}
finally {await browser.close();}
