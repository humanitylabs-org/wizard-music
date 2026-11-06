// Focused Identify behavior + appearance, real shell + app + isolated hub.
// Browser capture is synthetic; no claim is made about a real handset recording.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
const web = path.resolve(process.env.QA_SHELL_WEB)
const out = path.resolve(process.env.OUT || 'evidence/identify')
fs.mkdirSync(out,{recursive:true})
const ORIGIN='http://127.0.0.1:19371', APP='http://127.0.0.1:19305'
const types={'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.json':'application/json','.woff2':'font/woff2'}
const data=await (await fetch(APP+'/wizard-music/api/identify/captures')).json()
assert.equal(data.captures.length,5,'all five original hunts are imported before browser exercise')
const hunt=data.captures.find(h=>h.status==='has_leads')
assert.ok(hunt)
const wav=fs.readFileSync(process.env.QA_AUDIO).toString('base64')
const fakeCapture=`
window.__qaStarts=[];window.__qaAcks=[];
window.WizardApp=Object.freeze({...window.WizardApp,capture:{
start:async options=>{window.__qaStarts.push(options);if(window.__qaHold)await new Promise((r,j)=>{window.__qaResolve=r;window.__qaReject=j});const id=crypto.randomUUID(),startedAt=Date.now();return {id,onLevel:fn=>{fn(.45);return()=>{}},stop:async()=>({id,startedAt,durationMs:1200,mime:'audio/wav',meta:options.meta,blob:new Blob([Uint8Array.from(atob(${JSON.stringify(wav)}),c=>c.charCodeAt(0))],{type:'audio/wav'})})}},pending:async()=>[],ack:async id=>{window.__qaAcks.push(id);try{const a=JSON.parse(localStorage.getItem('qa.acks')||'[]');a.push({id,href:location.href,t:Date.now()});localStorage.setItem('qa.acks',JSON.stringify(a))}catch{}return true}
}});
`
const rows=[]
const browser=await chromium.launch({headless:true,args:['--disable-gpu']})
try {
for(const shell of ['phone','desktop'])for(const skin of ['nebula','grove']){
 const context=await browser.newContext(shell==='phone'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1}:{viewport:{width:1440,height:900}})
 let offline=false
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url())
  if(u.origin!==ORIGIN)return route.abort()
  if(u.pathname.startsWith('/wizard-music/')){
   if(offline && req.method()==='POST')return route.abort('internetdisconnected')
   const response=await context.request.fetch(APP+u.pathname+u.search,{method:req.method(),headers:{...(req.headers()['content-type']?{'content-type':req.headers()['content-type']}:{})},data:req.postDataBuffer()||undefined})
   const headers={...response.headers()};delete headers['content-security-policy']
   return route.fulfill({status:response.status(),headers,body:await response.body()})
  }
  if(u.pathname.endsWith('/data.js'))return route.fulfill({contentType:'application/javascript',body:'window.WIZ_DATA={threads:[],projects:{}};'})
  if(u.pathname.endsWith('/summaries.js'))return route.fulfill({contentType:'application/javascript',body:'window.WIZ_SUMMARIES={};'})
  // The shell only reads the box app list through bootstrap's advertised endpoint (core/config.js).
  if(u.pathname==='/wizard/v1/bootstrap')return route.fulfill({json:{bootstrap:1,endpoints:{apps:'/wizard/v1/apps'},capabilities:{voice:true},settings:{}}})
  // A real owner box has an AI signed in and setup finished, so the first-run Welcome never covers the app.
  if(u.pathname==='/wizard/hermes/api/model/options')return route.fulfill({json:{provider:'anthropic',providers:[{slug:'anthropic',authenticated:true}]}})
  if(u.pathname==='/wizard/v1/setup')return route.fulfill({json:{first_run:false,state:'done'}})
  if(u.pathname==='/wizard/v1/apps')return route.fulfill({json:{apps:[{id:'wizard-music',name:'Music',url:'/wizard-music/',view:{mode:'original',url:'/wizard-music/'},source:'apps.json',type:'service',provides:['music','voice-commands'],voice_names:['Music','Wizard Music']}]}})
  if(u.pathname.startsWith('/wizard/') || u.pathname.startsWith('/api/') || u.pathname.startsWith('/notifications/') || u.pathname.startsWith('/pages/')){
   if(req.method()!=='GET')return route.fulfill({status:403,json:{error:'No owner writes in isolated QA'}})
   return route.fulfill({json:u.pathname.endsWith('/ui-preferences')?{pinnedChats:[],spaces:[],migrations:{'launcher.v1':true}}:u.pathname.endsWith('/sessions')?{data:[],has_more:false}:u.pathname.endsWith('/items')?{items:[]}:u.pathname.endsWith('/count')?{unread:0,needs:0}:{}})
  }
  const rel=decodeURIComponent(u.pathname.replace(/^\/wizard-os-home\//,''))||'index.html'
  const f=path.resolve(web,rel)
  if(f.startsWith(web+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){
   let body=fs.readFileSync(f)
   if(rel==='core/app-client.js')body=Buffer.concat([body,Buffer.from('\n'+fakeCapture)])
   return route.fulfill({contentType:types[path.extname(f)]||'application/octet-stream',body})
  }
  return route.fulfill({status:404,body:''})
 })
 await context.addInitScript(({shell,skin})=>{try{if(window.top===window){localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.v1','true');localStorage.setItem('wos.tour','done');localStorage.setItem('wos.tour.done','1');localStorage.setItem('wux.shell',shell);localStorage.setItem('wos.skin',skin)}}catch{}},{shell,skin})
 const page=await context.newPage(),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const consoleLines=[];page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleLines.push(m.type()+': '+m.text().slice(0,300))})
 const T0=Date.now(),ts=()=>'+'+(Date.now()-T0)+'ms'
 const tag=async r=>{try{const el=await r.frame().frameElement();return (await el.getAttribute('data-voice-service'))?'hidden':'visible'}catch{return 'page'}}
 const netLines=[];page.on('request',async r=>{if(r.url().includes('/identify/'))netLines.push(ts()+' '+await tag(r)+' '+r.method()+' '+r.url().slice(0,160))});page.on('requestfailed',r=>netLines.push(ts()+' FAILED '+r.method()+' '+r.url().slice(0,160)+' '+(r.failure()?.errorText||'')));page.on('response',r=>{if(r.url().includes('/identify/'))netLines.push(ts()+' RESP '+r.status()+' '+r.request().method()+' '+r.url().slice(0,160))})
 const dump=async(frame,label)=>{const ui=await frame.evaluate(()=>({alert:document.querySelector('[role=alert]')?.textContent||'',text:document.body.innerText.slice(0,800)})).catch(e=>({err:e.message}));await page.screenshot({path:path.join(out,`${shell}-${skin}-FAIL-${label}.png`)}).catch(()=>{});return JSON.stringify({label,ui,netLines:netLines.slice(-40),consoleLines:consoleLines.slice(-20),errors})}
 const acks=f=>f.evaluate(()=>JSON.parse(localStorage.getItem('qa.acks')||'[]').length)
 const waitAcks=async(f,n,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await acks(f).catch(()=>0)>=n)return;await new Promise(r=>setTimeout(r,250))}
  const replay=await f.evaluate(async()=>{const out={href:location.href,frameAcks:window.__qaAcks,shared:localStorage.getItem('qa.acks')};try{const d=await new Promise((res,rej)=>{const r=indexedDB.open('trackhunt-offline-v1',1);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const rows=await new Promise(res=>{const q=d.transaction('captures').objectStore('captures').getAll();q.onsuccess=()=>res(q.result)});out.locals=[];for(const it of rows){const dig=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await it.blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');const r=await fetch('/wizard-music/api/identify/captures/'+it.id,{credentials:'include'});let j=null;try{j=await r.json()}catch(e){j={parse:e.message}};out.locals.push({id:it.id,shared:it.sharedId,size:it.blob.size,digest:dig,status:r.status,server:{id:j?.id,raw_sha256:j?.raw_sha256,status:j?.status,error:j?.error}})}}catch(e){out.replayError=e.message}return out}).catch(e=>({evalError:e.message}))
  throw Error(label+' never confirmed: '+JSON.stringify({replay,frames:page.frames().map(x=>x.url()).filter(u=>u.includes('wizard-music'))})+' '+await dump(f,label))}
 await page.addInitScript(()=>{try{if(location.pathname.startsWith('/wizard-os-home/'))localStorage.setItem('wos.welcome.v1','done')}catch{}})
 await page.goto(ORIGIN+'/wizard-os-home/'+(shell==='phone'?'?shell=phone':'desktop.html'),{waitUntil:'load'})
 await page.waitForFunction(([sh,sk])=>document.documentElement.dataset.shell===sh&&document.documentElement.dataset.skin===sk,[shell,skin])
 await page.waitForFunction(()=>window.WizAppServices?.inspect().some(x=>x.appId==='wizard-music'&&x.ready))
 // The shell marks a frame ready when app-client connects; the app's React claim registers a moment later.
 // Wait for the real claim (bounded), and on failure dump what the hidden receiver actually has.
 const claimed=await page.waitForFunction(()=>!!window.WizAppServices.voiceCommand('music',{stage:'priority',kind:'command',view:{kind:'thread list'}}),null,{timeout:20000}).then(()=>true,()=>false)
 if(!claimed){
  const diag=await page.evaluate(()=>{const f=document.querySelector('iframe[data-voice-service="wizard-music"]');const w=f?.contentWindow;let reg='no-frame';try{if(w){w.WizardApp.voice.commands.register({claims:()=>false,receive:async()=>false});reg='nothing-registered'}}catch(e){reg='registered:'+e.message}return {frame:!!f,src:f?.src,root:w?.document.getElementById('root')?.outerHTML?.slice(0,300),reg,inspect:window.WizAppServices.inspect()}})
  throw Error('Music never claimed bare "music": '+JSON.stringify({diag,errors,consoleLines:consoleLines.slice(-20)}))
 }
 // Use the shell's real priority dispatcher with a deliberately colliding bare Music app name.
 const command=await page.evaluate(()=>{
  const grammar=window.WosCommands.create({CHATS:{},APP:{},appByName:()=>({name:'Music'}),findApp:()=>null,quickSearch:()=>null,sendSnap:()=>({view:{kind:'thread list'}})})
  const cmd=grammar.parse('music',{view:{kind:'thread list'}},'command')
  if(cmd?.action!=='app_voice')throw Error('Bare music was swallowed by app-open routing: '+JSON.stringify(cmd))
  if(!window.WosAppVoice.execute(cmd,'music',{}))throw Error('Identify claim was not admitted')
  return cmd.action
 })
 const visible=page.locator('iframe.appframe:not([data-voice-service])[src*="/wizard-music/"]').last()
 await visible.waitFor({state:'visible'})
 const frame=await (await visible.elementHandle()).contentFrame()
 await frame.getByRole('button',{name:'Stop and identify',exact:true}).waitFor({state:'visible'})
 netLines.push(ts()+' CLICK Stop and identify; starts='+JSON.stringify(await frame.evaluate(()=>window.__qaStarts.length)))
 await frame.getByRole('button',{name:'Stop and identify',exact:true}).click()
 netLines.push(ts()+' CLICKED')
 // Stop must take effect at once (the recording panel leaves Listening); a covered or swallowed tap fails here, not 30 s later.
 const stopped=await frame.waitForFunction(()=>!/Listening…/.test(document.querySelector('.identify-recording')?.textContent||''),null,{timeout:5000}).then(()=>true,()=>false)
 if(!stopped)throw Error('Stop and identify did not take effect: '+JSON.stringify({welcome:await page.evaluate(()=>({active:window.WosWelcome?.active,log:window.WosWelcome?.log}))})+' '+await dump(frame,'stop-click'))
 await waitAcks(frame,1,'Upload after Stop')
 // Open imported hunt and verify media really decodes.
 await frame.getByRole('button',{name:'Hunts',exact:true}).click()
 const row=frame.locator('.identify-hunt').filter({hasText:hunt.best_title}).first()
 await row.click()
 await frame.locator('dialog[open]').waitFor()
 await frame.waitForFunction(()=>{const a=document.querySelector('dialog audio');return a&&a.readyState>=1&&a.duration>0})
 const sheetImage=path.join(out,`${shell}-${skin}-identify-sheet.png`)
 await page.screenshot({path:sheetImage})
 // A physical click on the iframe backdrop closes the shared sheet.
 const box=await visible.boundingBox();await page.mouse.click(box.x+5,box.y+5)
 await frame.waitForFunction(()=>!document.querySelector('dialog[open]'))
 await row.click();await frame.locator('dialog[open]').waitFor()
 // Back closes detail, then list, then stays in Music (never exits the frame).
 await page.evaluate(el=>window.WizAppServices.back(el),await visible.elementHandle())
 await frame.waitForFunction(()=>!document.querySelector('dialog[open]'))
 await page.evaluate(el=>window.WizAppServices.back(el),await visible.elementHandle())
 await frame.waitForFunction(()=>!document.querySelector('.identify-view'))
 assert.ok(await visible.isVisible())
 // Held permission paints starting immediately, then offline stop persists without ack.
 await frame.evaluate(()=>{window.__qaHold=true})
 await frame.getByRole('button',{name:'Identify song',exact:true}).click()
 await frame.getByText('Starting microphone…',{exact:true}).waitFor()
 assert.equal(await frame.evaluate(()=>window.__qaStarts.length),2)
 await frame.evaluate(()=>{window.__qaHold=false;window.__qaResolve()})
 await frame.getByText('Listening…',{exact:true}).waitFor()
 offline=true
 await frame.getByRole('button',{name:'Stop and identify',exact:true}).click()
 await frame.getByText(/Saved on this device · waiting for connection/).first().waitFor()
 assert.equal(await acks(frame),1)
 offline=false
 await frame.evaluate(()=>dispatchEvent(new Event('online')))
 await waitAcks(frame,2,'Reconnect upload')
 await frame.getByRole('button',{name:'Hunts',exact:true}).click()
 const listImage=path.join(out,`${shell}-${skin}-identify-hunts.png`)
 await page.screenshot({path:listImage})
 rows.push({shell,skin,priority_bare_music:command,legacy_audio_decoded:true,back_sheet_list_home:true,held_permission_same_frame:true,offline_saved_reconnected:true,screenshots:[sheetImage,listImage],pageerrors:errors})
 await context.close()
}
} finally {await browser.close()}
fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify({ok:true,capture:'synthetic shared-capture port; real handset remains owner test',rows},null,2))
console.log(JSON.stringify({ok:true,rows},null,2))
