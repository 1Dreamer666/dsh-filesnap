import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Expects Settings → FileSnap to be open in the disposable demo. */
export async function captureSettings(page, root, shot) {
 const btn=name=>page.getByRole('button',{name,exact:true});
 await page.getByRole('combobox').selectOption('branch-status-titles-v1');
 await btn('扫描旧版数据').click();
 await page.getByText(/其中 1 个可迁移/).waitFor();
 await btn('确认迁移清单中的会话').scrollIntoViewIfNeeded();
 await shot('08-migrations');
 await btn('预览继续还原').click();
 await btn('确认恢复').waitFor();
 await page.getByRole('heading',{name:'预览继续还原',exact:true}).scrollIntoViewIfNeeded();
 await shot('09-interrupted-restore');
 await btn('取消').click();
 const path=join(root,'recovery-workspace/src/cart.ts');
 const original=await readFile(path);
 try {
  await writeFile(path,'// A manual edit made after the interruption.\n'+original.toString());
  await btn('预览继续还原').click();
  await page.getByRole('alert').waitFor();
  await btn('确认恢复').scrollIntoViewIfNeeded();
  if(!await btn('确认恢复').isDisabled()) throw new Error('Conflict must prevent confirmation.');
  await shot('10-recovery-conflict');
 } finally { await writeFile(path,original); }
 await btn('取消').click();
}
