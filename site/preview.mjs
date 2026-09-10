import http from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
const {base}=JSON.parse(await readFile(path.join(dir,'build-meta.json'),'utf8'));
const port=Number(process.env.PORT || 4174);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.xml':'application/xml; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png'};
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.writeHead(302,{Location:base});return res.end();}if(!u.pathname.startsWith(base)){res.writeHead(404);return res.end('Not found');}const filename=decodeURIComponent(u.pathname.slice(base.length));let target=path.resolve(dir,filename);if(target!==dir&&!target.startsWith(dir+path.sep)){res.writeHead(403);return res.end();}if((await stat(target)).isDirectory()){if(!u.pathname.endsWith('/')){res.writeHead(302,{Location:u.pathname+'/'});return res.end();}target=path.join(target,'index.html');}const data=await readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(path.join(dir,'404.html')));}}).listen(port,'0.0.0.0',()=>console.log(`Preview: http://localhost:${port}${base}`));
