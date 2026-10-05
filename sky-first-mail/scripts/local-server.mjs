import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import app from '../src/index.js';
import {database} from '../tests/db.mjs';
const objects=new Map();const env={DB:database(),SETUP_SECRET:'local-mail-setup',MAIL_STORAGE:{async put(k,v){objects.set(k,v)},async get(k){const v=objects.get(k);return v?{arrayBuffer:async()=>v}:null},async delete(k){objects.delete(k)}}};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://'+req.headers.host);if(url.pathname.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);const r=await app.fetch(new Request(url,{method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined}),env);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}else{const file=path.resolve('public','.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(path.resolve('public')+path.sep))throw Error();const bytes=await fs.readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(bytes);}}catch(e){res.writeHead(500);res.end('Local server error');}}).listen(8790,'127.0.0.1',()=>console.log('Local only: http://localhost:8790/#setup=local-mail-setup; memory data; no external sending'));
