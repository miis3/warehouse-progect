import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWarehouseHandler} from '../supabase/functions/warehouse-api/handler.mjs';
import {database,hash,manifest} from '../tests/database-helpers.mjs';

export const PREVIEW_ADMIN=Object.freeze({
  username:'preview-admin',
  password:'Warehouse-Preview-2026!'
});

const dist=resolve(import.meta.dirname,'../warehouse-project/site/dist');
const contentTypes=new Map([
  ['.css','text/css; charset=utf-8'],['.gif','image/gif'],['.html','text/html; charset=utf-8'],
  ['.jpeg','image/jpeg'],['.jpg','image/jpeg'],['.js','text/javascript; charset=utf-8'],
  ['.json','application/json; charset=utf-8'],['.png','image/png'],['.svg','image/svg+xml; charset=utf-8']
]);
const runtimeConfig="// Isolated local test preview. No Supabase key is used.\nwindow.WAREHOUSE_CONFIG = Object.freeze({apiUrl: '/api/warehouse', gatewayKey: ''});\n";

function securityHeaders(){
  return {
    'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY'
  };
}

async function seedPreview(db){
  const adminId=randomUUID(),seedToken=randomUUID();
  await db.query(
    'insert into warehouse.staff_accounts(user_id,username,full_name,role) values($1,$2,$3,$4)',
    [adminId,PREVIEW_ADMIN.username,'مدير نسخة الاختبار','manager']
  );
  await db.query('select public.warehouse_admin_login($1,$2)',[adminId,hash(seedToken)]);
  const item=manifest.items.find(entry=>entry.name?.includes('منشار')&&!entry.is_group);
  if(!item)throw new Error('لم يتم العثور على معدة الاختبار في ملف المخزون');
  await db.query(
    'select public.warehouse_api($1,$2,$3::jsonb)',
    ['review_item',hash(seedToken),JSON.stringify({item_id:item.id,quantity:1,condition:'sound',notes:'قطعة مهيأة تلقائيًا لنسخة الاختبار المحلية'})]
  );
  await db.query('select public.warehouse_api($1,$2,$3::jsonb)',['logout',hash(seedToken),'{}']);
  return {adminId,item};
}

async function requestBody(request){
  const parts=[];
  for await(const part of request)parts.push(part);
  return Buffer.concat(parts);
}

export async function createTestPreview({host='127.0.0.1',port=8000}={}){
  const db=await database();
  const seeded=await seedPreview(db);
  // Model Supabase Auth only inside this isolated preview process. The
  // warehouse RPCs still enforce every staff role and session permission.
  const authPasswords=new Map([[seeded.adminId,PREVIEW_ADMIN.password]]);
  const rpc=async(name,args)=>{
    const entries=Object.entries(args);
    const values=entries.map(([,value])=>typeof value==='object'?JSON.stringify(value):value);
    const placeholders=entries.map(([key],index)=>`${key} => $${index+1}`).join(',');
    return (await db.query(`select public.${name}(${placeholders}) as data`,values)).rows[0].data;
  };
  let origin;
  let handler;

  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/',origin||`http://${host}:${port}`);
      if(url.pathname==='/healthz'){
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8',...securityHeaders()});res.end('ok');return;
      }
      if(url.pathname==='/api/warehouse'){
        const body=req.method==='GET'||req.method==='HEAD'?undefined:await requestBody(req);
        const edgeResponse=await handler(new Request(new URL(url.pathname,origin),{
          method:req.method,headers:req.headers,body
        }));
        res.writeHead(edgeResponse.status,Object.fromEntries(edgeResponse.headers));
        res.end(Buffer.from(await edgeResponse.arrayBuffer()));return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){
        res.writeHead(405,{'Content-Type':'text/plain; charset=utf-8',...securityHeaders()});res.end('Method Not Allowed');return;
      }
      if(url.pathname==='/warehouse-config.js'){
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8',...securityHeaders()});
        res.end(req.method==='HEAD'?'':runtimeConfig);return;
      }
      const pathname=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
      const filePath=resolve(dist,`.${pathname}`);
      if(filePath!==dist&&!filePath.startsWith(dist+sep)){
        res.writeHead(403,securityHeaders());res.end('Forbidden');return;
      }
      try{
        const body=await readFile(filePath);
        const cache=pathname==='/index.html'?'no-store':'public, max-age=3600';
        res.writeHead(200,{'Content-Type':contentTypes.get(extname(filePath).toLowerCase())||'application/octet-stream',...securityHeaders(),'Cache-Control':cache});
        res.end(req.method==='HEAD'?'':body);
      }catch(error){
        if(error.code!=='ENOENT')throw error;
        res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8',...securityHeaders()});res.end('Not Found');
      }
    }catch(error){
      console.error(error);
      if(!res.headersSent)res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8',...securityHeaders()});
      res.end('Preview server error');
    }
  });
  await new Promise((resolveListen,reject)=>{
    server.once('error',reject);
    server.listen(port,host,resolveListen);
  });
  const address=server.address();
  origin=`http://${host}:${address.port}`;
  handler=createWarehouseHandler({
    env:name=>name==='ALLOWED_ORIGINS'?origin:undefined,
    rpc,
    authenticateAdmin:async(username,password)=>{
      const id=await rpc('warehouse_admin_identity',{p_username:username});
      return id&&authPasswords.get(id)===password?id:null;
    },
    createAuthUser:async password=>{
      const id=randomUUID();
      authPasswords.set(id,password);
      return id;
    },
    updateAuthPassword:async(id,password)=>{
      if(!authPasswords.has(id))throw new Error('Preview staff identity missing');
      authPasswords.set(id,password);
    }
  });
  const close=async()=>{
    await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
    await db.close();
  };
  return {server,db,url:origin,credentials:PREVIEW_ADMIN,sample:seeded.item,close};
}

async function main(){
  const port=Number.parseInt(process.env.WAREHOUSE_PREVIEW_PORT||'8000',10);
  const preview=await createTestPreview({port});
  console.log('');
  console.log('نسخة اختبار المستودع جاهزة (بيانات مؤقتة ومعزولة)');
  console.log(`الرابط: ${preview.url}`);
  console.log(`دخول الإدارة: ${preview.credentials.username} / ${preview.credentials.password}`);
  console.log('دخول العامل: استخدم أي اسم عربي ورقم وظيفي جديد مثل 70001');
  console.log(`ابحث عن: منشار — القطعة المهيأة: ${preview.sample.name.replace(/\s+/g,' ')}`);
  console.log('لإيقاف النسخة اضغط Ctrl+C؛ كل بيانات التجربة ستُحذف.');
  const stop=async()=>{await preview.close();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
