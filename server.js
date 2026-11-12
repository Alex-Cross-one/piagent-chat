import express from 'express';
import { Agent } from '@earendil-works/pi-agent-core';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
export function createApp({dataDir=resolve(root,'data'),token=process.env.CHAT_ACCESS_TOKEN,provider=process.env.PI_PROVIDER||'openai',modelId=process.env.PI_MODEL||'gpt-4o-mini',secure=process.env.COOKIE_SECURE==='true',agentFactory}={}){
 if(!token||token.length<24) throw new Error('Set CHAT_ACCESS_TOKEN to at least 24 random characters.');
 const app=express(), auth=new Map(), attempts=new Map(), active=new Map();
 const models=builtinModels(); const model=models.getModel(provider,modelId); if(!model) throw new Error('Unknown PI_PROVIDER / PI_MODEL combination.');
 const ready=mkdir(dataDir,{recursive:true,mode:0o700});
 const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)};
 const path=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Object.assign(new Error('Not found'),{status:404});return resolve(dataDir,id+'.json')};
 const load=async id=>{await ready;try{return JSON.parse(await readFile(path(id),'utf8'))}catch(e){if(e.code==='ENOENT')e.status=404;throw e}};
 const save=async s=>{await ready;const p=path(s.id),tmp=p+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(s),{mode:0o600});await rename(tmp,p)};
 app.disable('x-powered-by');
 app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});if(['POST','DELETE','PUT','PATCH'].includes(req.method)&&req.headers.origin&&!['http://','https://'].some(scheme=>req.headers.origin===scheme+req.get('host')))return res.status(403).json({error:'Cross-origin request blocked'});next()});
 app.use(express.json({limit:'40kb'}));
 const cookie=(v,age)=>`pi_session=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`;
 app.post('/api/login',(req,res)=>{const now=Date.now(),ip=req.ip;let a=attempts.get(ip);if(!a||a.until<now){a={count:0,until:now+900000};attempts.set(ip,a)}if(++a.count>15)return res.status(429).json({error:'尝试过多，请 15 分钟后重试'});if(!equal(req.body?.token,token))return res.status(401).json({error:'访问口令不正确'});const id=randomBytes(32).toString('hex');auth.set(id,now+86400000);res.setHeader('Set-Cookie',cookie(id,86400));res.json({ok:true})});
 app.use('/api',(req,res,next)=>{const id=req.headers.cookie?.split('; ').find(c=>c.startsWith('pi_session='))?.slice(11);if(!id||!auth.has(id)||auth.get(id)<Date.now()){if(id)auth.delete(id);return res.status(401).json({error:'请先登录'})}req.sessionId=id;next()});
 app.post('/api/logout',(req,res)=>{auth.delete(req.sessionId);res.setHeader('Set-Cookie',cookie('',0));res.json({ok:true})});
 app.get('/api/config',(_req,res)=>res.json({provider,model:modelId,configured:!!(process.env.PI_API_KEY)}));
 app.get('/api/sessions',async(_req,res)=>{await ready;const list=await Promise.all((await readdir(dataDir)).filter(x=>x.endsWith('.json')).map(async x=>{const s=await load(x.slice(0,-5));return {id:s.id,title:s.title,updatedAt:s.updatedAt}}));res.json(list.sort((a,b)=>b.updatedAt-a.updatedAt))});
 app.post('/api/sessions',async(_req,res)=>{const s={id:randomUUID(),title:'新的对话',updatedAt:Date.now(),messages:[]};await save(s);res.status(201).json(s)});
 app.get('/api/sessions/:id',async(req,res)=>res.json(await load(req.params.id)));
 app.delete('/api/sessions/:id',async(req,res)=>{if(active.has(req.params.id))return res.status(409).json({error:'请先停止生成'});await load(req.params.id);await unlink(path(req.params.id));res.json({ok:true})});
 app.post('/api/sessions/:id/stop',(req,res)=>{active.get(req.params.id)?.abort();res.json({ok:true})});
 app.post('/api/sessions/:id/messages',async(req,res)=>{
  const text=req.body?.message;if(typeof text!=='string'||!text.trim()||text.length>16000)return res.status(400).json({error:'请输入 1–16000 字符'});
  if(active.has(req.params.id)||active.size>=3)return res.status(409).json({error:'已有回答正在生成，请稍候'});
  const s=await load(req.params.id);if(active.has(s.id))return res.status(409).json({error:'正在生成'});
  if(!agentFactory&&!process.env.PI_API_KEY)return res.status(503).json({error:'服务端尚未配置模型 API key，请查看 README'});
  const options={streamFn:models.streamSimple.bind(models),initialState:{systemPrompt:process.env.SYSTEM_PROMPT||'你是 dot，一个友好、准确的中文个人助手。你运行在独立的 pi 平台，不是 ChatGPT 内的 dot，无法访问其中的会话、记忆、插件或提醒。没有联网、交易或文件执行工具。不要声称完成了未执行的动作。',model,messages:s.messages.filter(m=>m.role!=='assistant'||!['error','aborted'].includes(m.stopReason)).slice(-40),tools:[]},getApiKey:()=>process.env.PI_API_KEY};
  const agent=agentFactory?agentFactory(options):new Agent(options);active.set(s.id,agent);const initialCount=agent.state.messages.length;
  res.set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  const send=(event,data)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)};
  let failed=false;const unsub=agent.subscribe(e=>{if(e.type==='message_update'&&e.assistantMessageEvent.type==='text_delta')send('delta',{text:e.assistantMessageEvent.delta});if(e.type==='message_end'&&e.message.role==='assistant'&&e.message.stopReason==='error'){failed=true;send('error',{message:'模型请求失败，请检查服务端模型配置、额度及网络。'})}});
  const timer=setTimeout(()=>agent.abort(),120000),heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n')},15000);res.on('close',()=>agent.abort());
  try{await agent.prompt(text.trim());s.messages.push(...agent.state.messages.slice(initialCount).filter(m=>m.role!=='system'));s.title=s.title==='新的对话'?text.trim().slice(0,36):s.title;s.updatedAt=Date.now();await save(s);send('done',{failed})}catch{send('error',{message:'生成或保存失败，请稍后重试。'})}finally{clearTimeout(timer);clearInterval(heartbeat);unsub();active.delete(s.id);res.end()}
 });
 app.use(express.static(resolve(root,'public')));
 app.use((err,_req,res,_next)=>{if(!res.headersSent)res.status(err.status||500).json({error:err.status===404?'对话不存在':'请求失败'})});
 return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT||3000);createApp().listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`pi chat: http://localhost:${port}`))}
