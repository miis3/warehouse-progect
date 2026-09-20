import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {pathToFileURL} from 'node:url';

const dist=resolve(import.meta.dirname,'../warehouse-project/site/dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.json':'application/json'};
export async function startLocalSupabase({port=8004,fetchImpl=fetch,config:override}={}){
 const source=await readFile(resolve(dist,'warehouse-config.js'),'utf8');
 const config=override||JSON.parse(source.match(/Object\.freeze\((\{[^;]+\})\)/)?.[1]||'{}');
 const endpoint=new URL(config.apiUrl);
 if(endpoint.protocol!=='https:'||!endpoint.hostname.endsWith('.supabase.co')||endpoint.pathname!=='/functions/v1/warehouse-api')throw new Error('Expected a Supabase warehouse-api HTTPS endpoint');
 const key=config.gatewayKey||'';
 let publicKey=false;
 try{publicKey = JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role==='anon';}catch{}
 if(!publicKey)throw new Error('A public legacy anon JWT is required by verify_jwt=true');
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"};
 let origin;
 const server=createServer(async(req,res)=>{
  const send=(code,body,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(body);};
  try{
   if(req.headers.host!==new URL(origin).host)return send(403,'{"error":"عنوان محلي غير مسموح"}');
   const url=new URL(req.url,origin);
   if(url.pathname==='/api/warehouse'){
    if(req.method!=='POST')return send(405,'{"error":"POST only"}');
    if(req.headers.origin&&req.headers.origin!==origin)return send(403,'{"error":"أصل غير مسموح"}');
    if(!(req.headers['content-type']||'').startsWith('application/json'))return send(415,'{"error":"JSON only"}');
    let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>100000)return send(413,'{"error":"طلب كبير"}');chunks.push(c);}
    const upstream=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),
     headers:{'Content-Type':'application/json',apikey:key,Authorization:'Bearer '+key,...(req.headers['x-warehouse-session']?{'X-Warehouse-Session':req.headers['x-warehouse-session']}:{})},body:Buffer.concat(chunks)});
    return send(upstream.status,Buffer.from(await upstream.arrayBuffer()));
   }
   if(req.method!=='GET'&&req.method!=='HEAD')return send(405,'Method not allowed','text/plain');
   if(url.pathname==='/healthz')return send(200,req.method==='HEAD'?'':'ok','text/plain');
   if(url.pathname==='/warehouse-config.js')return send(200,req.method==='HEAD'?'':"window.WAREHOUSE_CONFIG=Object.freeze({apiUrl:'/api/warehouse',gatewayKey:''});",types['.js']);
   const target=resolve(dist,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
   if(!target.startsWith(dist+sep))return send(403,'Forbidden','text/plain');
   const body=await readFile(target);send(200,req.method==='HEAD'?'':body,types[extname(target)]||'application/octet-stream');
  }catch(error){send(error.code==='ENOENT'?404:502,error.code==='ENOENT'?'Not found':'{"error":"تعذر الاتصال بقاعدة Supabase؛ لم يتأكد حفظ العملية"}');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 origin='http://127.0.0.1:'+server.address().port;
 return {origin,close:()=>new Promise(resolve=>server.close(resolve))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=await startLocalSupabase({port:Number(process.env.WAREHOUSE_LOCAL_PORT||8004)});
 console.log(`نسخة محلية متصلة بقاعدة Supabase الحالية: ${app.origin}\nلا تُنشأ بيانات أو حسابات أو كميات تلقائيًا. استخدم حساب الإدارة الحقيقي الموجود.\nإيقاف الخادم لا يحذف بيانات Supabase.`);
}
