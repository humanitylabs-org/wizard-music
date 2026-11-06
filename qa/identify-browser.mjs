// Focused Identify behavior + appearance, real shell + app + isolated hub.
// Browser capture is synthetic; no claim is made about a real handset recording.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { checkPlaylists } from './playlist-check.mjs'
import { chromium } from 'playwright'
const web = path.resolve(process.env.QA_SHELL_WEB)
const out = path.resolve(process.env.OUT || 'evidence/identify')
fs.mkdirSync(out,{recursive:true})
const ORIGIN=process.env.QA_SHELL_ORIGIN||'http://127.0.0.1:19371', APP=process.env.QA_APP_ORIGIN||'http://127.0.0.1:19305'
const playlistOnly=process.env.MUSIC_PLAYLIST_ONLY==='1'
const types={'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.json':'application/json','.woff2':'font/woff2'}
const data=await (await fetch(APP+'/wizard-music/api/identify/captures')).json()
const discardOnly=process.env.IDENTIFY_DISCARD_ONLY==='1'
const localOnly=process.env.IDENTIFY_LOCAL_DISCARD_ONLY==='1'
if(!discardOnly)assert.equal(data.captures.length,5,'all five original hunts are imported before browser exercise')
const hunt=data.captures.find(h=>h.status==='has_leads')
if(!discardOnly)assert.ok(hunt)
const wav=fs.readFileSync(process.env.QA_AUDIO).toString('base64')
const fakeCapture=`
window.__qaStarts=[];window.__qaAcks=[];
window.WizardApp=Object.freeze({...window.WizardApp,capture:{
start:async options=>{window.__qaStarts.push(options);if(window.__qaHold)await new Promise((r,j)=>{window.__qaResolve=r;window.__qaReject=j});const id=crypto.randomUUID(),startedAt=Date.now();return {id,onLevel:fn=>{fn(.45);return()=>{}},stop:async()=>({id,startedAt,durationMs:1200,mime:'audio/wav',meta:options.meta,blob:new Blob([Uint8Array.from(atob(${JSON.stringify(wav)}),c=>c.charCodeAt(0))],{type:'audio/wav'})})}},pending:async()=>localStorage.getItem('qa.local.pending')?[{id:localStorage.getItem('qa.local.pending'),startedAt:Date.now(),durationMs:7000,mime:'audio/wav',meta:{task:'music-identify'},blob:new Blob([Uint8Array.from(atob(${JSON.stringify(wav)}),c=>c.charCodeAt(0))],{type:'audio/wav'})}]:[],ack:async id=>{if(localStorage.getItem('qa.local.pending')){const saved=await(await fetch('/wizard-music/api/identify/captures/'+id)).json();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(${JSON.stringify(wav)}),c=>c.charCodeAt(0)))),n=>n.toString(16).padStart(2,'0')).join('');if(saved.id!==id||saved.raw_sha256!==digest)throw Error('Ack before durable backend readback');localStorage.removeItem('qa.local.pending')}window.__qaAcks.push(id);try{const a=JSON.parse(localStorage.getItem('qa.acks')||'[]');a.push({id,href:location.href,t:Date.now()});localStorage.setItem('qa.acks',JSON.stringify(a))}catch{}return true}
}});
`
const rows=[]
const browser=await chromium.launch({headless:true,args:['--disable-gpu']})
let activeContext=null, currentStep='launch', diagnostic=null
const closingContexts=new WeakSet(), routeErrors=[]
const checkpoint=(step,state={})=>{currentStep=step;fs.appendFileSync(path.join(out,'browser-journal.jsonl'),JSON.stringify({step,...state})+'\n')}
const closeContext=async context=>{closingContexts.add(context);await context.unrouteAll({behavior:'ignoreErrors'});await context.close();if(activeContext===context)activeContext=null}
try {
for(const shell of ['phone','desktop'])for(const skin of ['nebula','grove']){
 const context=await browser.newContext(shell==='phone'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1}:{viewport:{width:1440,height:900}})
 activeContext=context;checkpoint('context',{shell,skin});diagnostic=null
 let offline=false,refusedPosts=0
 await context.route('**/*',async route=>{
  try {
  const req=route.request(),u=new URL(req.url())
  if(u.origin!==ORIGIN)return await route.abort()
  if(u.pathname==='/qa-local-seed')return await route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Disposable local fixture</title>'})
  if(u.pathname.startsWith('/wizard-music/')){
   if(offline && req.method()==='POST'){refusedPosts++;return await route.abort('internetdisconnected')}
   const response=await context.request.fetch(APP+u.pathname+u.search,{method:req.method(),headers:{...(req.headers()['content-type']?{'content-type':req.headers()['content-type']}:{})},data:req.postDataBuffer()||undefined})
   const headers={...response.headers()};delete headers['content-security-policy']
   return await route.fulfill({status:response.status(),headers,body:await response.body()})
  }
  if(u.pathname.endsWith('/data.js'))return await route.fulfill({contentType:'application/javascript',body:'window.WIZ_DATA={threads:[],projects:{}};'})
  if(u.pathname.endsWith('/summaries.js'))return await route.fulfill({contentType:'application/javascript',body:'window.WIZ_SUMMARIES={};'})
  // The shell only reads the box app list through bootstrap's advertised endpoint (core/config.js).
  if(u.pathname==='/wizard/v1/bootstrap')return await route.fulfill({json:{bootstrap:1,endpoints:{apps:'/wizard/v1/apps'},capabilities:{voice:true},settings:{}}})
  // A real owner box has an AI signed in and setup finished, so the first-run Welcome never covers the app.
  if(u.pathname==='/wizard/hermes/api/model/options')return await route.fulfill({json:{provider:'anthropic',providers:[{slug:'anthropic',authenticated:true}]}})
  if(u.pathname==='/wizard/v1/setup')return await route.fulfill({json:{first_run:false,state:'done'}})
  if(u.pathname==='/wizard/v1/apps')return await route.fulfill({json:{apps:[{id:'wizard-music',name:'Music',url:'/wizard-music/',view:{mode:'original',url:'/wizard-music/'},source:'launcher.json',type:'service',provides:['music'],voice_names:['Music','Wizard Music'],voice_routes:[{words:['music','shazam'],open:'?view=identify&listen=1',rest_param:'q'}]}]}})
  if(u.pathname.startsWith('/wizard/') || u.pathname.startsWith('/api/') || u.pathname.startsWith('/notifications/') || u.pathname.startsWith('/pages/')){
   if(req.method()!=='GET')return await route.fulfill({status:403,json:{error:'No owner writes in isolated QA'}})
   return await route.fulfill({json:u.pathname.endsWith('/ui-preferences')?{pinnedChats:[],spaces:[],migrations:{'launcher.v1':true}}:u.pathname.endsWith('/sessions')?{data:[],has_more:false}:u.pathname.endsWith('/items')?{items:[]}:u.pathname.endsWith('/count')?{unread:0,needs:0}:{}})
  }
  const rel=decodeURIComponent(u.pathname.replace(/^\/wizard-os-home\//,''))||'index.html'
  const f=path.resolve(web,rel)
  if(f.startsWith(web+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){
   let body=fs.readFileSync(f)
   if(rel==='core/app-client.js')body=Buffer.concat([body,Buffer.from('\n'+fakeCapture)])
   return await route.fulfill({contentType:types[path.extname(f)]||'application/octet-stream',body})
  }
  return await route.fulfill({status:404,body:''})
  } catch(error) {
   if(!closingContexts.has(context))routeErrors.push({url:route.request().url(),error:error.stack||error.message})
   await route.abort().catch(()=>{})
  }
 })
 await context.addInitScript(({shell,skin})=>{try{if(window.top===window){localStorage.setItem('wos.coached','true');localStorage.setItem('wos.tour.v1','true');localStorage.setItem('wos.tour','done');localStorage.setItem('wos.tour.done','1');localStorage.setItem('wux.shell',shell);localStorage.setItem('wos.skin',skin)}}catch{}},{shell,skin})
 const page=await context.newPage(),errors=[]
 if(localOnly){
  await page.goto(ORIGIN+'/qa-local-seed')
  await page.evaluate(async wav=>{
   const id=crypto.randomUUID();localStorage.setItem('qa.local.pending',id);localStorage.setItem('qa.local.id',id)
   const d=await new Promise((res,rej)=>{const r=indexedDB.open('trackhunt-offline-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('captures',{keyPath:'id'});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})
   await new Promise((res,rej)=>{const t=d.transaction('captures','readwrite');t.objectStore('captures').put({id,sharedId:id,blob:new Blob([Uint8Array.from(atob(wav),c=>c.charCodeAt(0))],{type:'audio/wav'}),mime:'audio/wav',client_ts:'2026-11-06T19:00:00Z',duration_s:7,sendRequested:false});t.oncomplete=res;t.onerror=()=>rej(t.error)});d.close()
  },wav)
 }
 page.on('pageerror',e=>errors.push(e.message))
 const consoleLines=[];page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleLines.push(m.type()+': '+m.text().slice(0,300))})
 const T0=Date.now(),ts=()=>'+'+(Date.now()-T0)+'ms'
 const tag=async r=>{try{const el=await r.frame().frameElement();return (await el.getAttribute('data-voice-service'))?'hidden':'visible'}catch{return 'page'}}
 const netLines=[];page.on('request',async r=>{if(r.url().includes('/identify/'))netLines.push(ts()+' '+await tag(r)+' '+r.method()+' '+r.url().slice(0,160))});page.on('requestfailed',r=>netLines.push(ts()+' FAILED '+r.method()+' '+r.url().slice(0,160)+' '+(r.failure()?.errorText||'')));page.on('response',r=>{if(r.url().includes('/identify/'))netLines.push(ts()+' RESP '+r.status()+' '+r.request().method()+' '+r.url().slice(0,160))})
 const dump=async(frame,label)=>{const ui=await frame.evaluate(()=>({alert:document.querySelector('[role=alert]')?.textContent||'',text:document.body.innerText.slice(0,800)})).catch(e=>({err:e.message}));await page.screenshot({path:path.join(out,`${shell}-${skin}-FAIL-${label}.png`)}).catch(()=>{});return JSON.stringify({label,ui,netLines:netLines.slice(-40),consoleLines:consoleLines.slice(-20),errors})}
 diagnostic=async()=>({shell,skin,frames:page.frames().map(f=>f.url()),netLines:netLines.slice(-40),errors,consoleLines:consoleLines.slice(-20)})
 // Bounded settle before a raster: the frame's box in the shell and the target's box hold still for six
 // animation frames with no finite animation running (endless breathing/ripples and the per-tick ring fill are
 // the product's own steady motion and are not waited on). Never disables motion or edits styles.
 const still=([target,n])=>{const node=typeof target==='string'?document.querySelector(target):target;const r=node?.getBoundingClientRect();const key=r?[r.x,r.y,r.width,r.height].map(Math.round).join():'none'
  const moving=document.getAnimations().some(a=>a.playState==='running'&&a.transitionProperty!=='stroke-dashoffset'&&Number.isFinite(a.effect?.getComputedTiming?.().endTime))
  const s=window.__qaStill||(window.__qaStill={key:'',n:0});if(moving||key!==s.key){s.key=key;s.n=0;return false};return ++s.n>=n}
 const settle=async(f,sel)=>{
  const host=f.parentFrame()||page.mainFrame(),frameEl=await f.frameElement()
  await host.evaluate(()=>{window.__qaStill=null});await f.evaluate(()=>{window.__qaStill=null})
  const t=Date.now()
  const shellStill=await host.waitForFunction(still,[frameEl,6],{polling:'raf',timeout:4000}).then(()=>true,()=>false)
  const appStill=await f.waitForFunction(still,[sel,6],{polling:'raf',timeout:4000}).then(()=>true,()=>false)
  return {shellStill,appStill,ms:Date.now()-t}
 }
 // Scroll every scrolled app element back to its top, assert the target is wholly inside the visible frame, then settle.
 const atTop=async(f,sel)=>{
  await f.evaluate(()=>{for(const el of [document.scrollingElement,...document.querySelectorAll('*')])if(el&&(el.scrollTop||el.scrollLeft))el.scrollTo({top:0,left:0,behavior:'instant'})})
  const r=await f.locator(sel).first().evaluate(el=>{const b=el.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,h:innerHeight,w:innerWidth}})
  assert.ok(r.top>=0&&r.left>=0&&r.bottom<=r.h&&r.right<=r.w,sel+' is outside the visible app: '+JSON.stringify(r))
  return {...await settle(f,sel),rect:r}
 }
 const acks=f=>f.evaluate(()=>JSON.parse(localStorage.getItem('qa.acks')||'[]').length)
 const waitAcks=async(f,n,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await acks(f).catch(()=>0)>=n)return;await new Promise(r=>setTimeout(r,250))}
  const replay=await f.evaluate(async()=>{const out={href:location.href,frameAcks:window.__qaAcks,shared:localStorage.getItem('qa.acks')};try{const d=await new Promise((res,rej)=>{const r=indexedDB.open('trackhunt-offline-v1',1);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const rows=await new Promise(res=>{const q=d.transaction('captures').objectStore('captures').getAll();q.onsuccess=()=>res(q.result)});out.locals=[];for(const it of rows){const dig=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await it.blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');const r=await fetch('/wizard-music/api/identify/captures/'+it.id,{credentials:'include'});let j=null;try{j=await r.json()}catch(e){j={parse:e.message}};out.locals.push({id:it.id,shared:it.sharedId,size:it.blob.size,digest:dig,status:r.status,server:{id:j?.id,raw_sha256:j?.raw_sha256,status:j?.status,error:j?.error}})}}catch(e){out.replayError=e.message}return out}).catch(e=>({evalError:e.message}))
  throw Error(label+' never confirmed: '+JSON.stringify({replay,frames:page.frames().map(x=>x.url()).filter(u=>u.includes('wizard-music'))})+' '+await dump(f,label))}
 await page.addInitScript(()=>{try{if(location.pathname.startsWith('/wizard-os-home/'))localStorage.setItem('wos.welcome.v1','done')}catch{}})
 await page.goto(ORIGIN+'/wizard-os-home/'+(shell==='phone'?'?shell=phone':'desktop.html'),{waitUntil:'load'})
 await page.waitForFunction(([sh,sk])=>document.documentElement.dataset.shell===sh&&document.documentElement.dataset.skin===sk,[shell,skin])
 await page.waitForFunction(sh=>window.WizCore.apps(sh).APP['wizard-music']?.voice_routes?.length,shell)
 const command=playlistOnly?await page.evaluate(()=>{if(!window.WizOpenApp('wizard-music','/wizard-music/'))throw Error('Music did not open');return 'playlists'}):localOnly?await page.evaluate(()=>{if(!window.WizOpenApp('wizard-music','/wizard-music/?view=identify'))throw Error('Music did not open');return 'persisted-unsent'}):await page.evaluate(sh=>{
  const registry=window.WizCore.apps(sh)
  const grammar=window.WosCommands.create({CHATS:{},...registry,quickSearch:()=>null,sendSnap:()=>({view:{kind:'thread list'}})})
  const cmd=grammar.parse('music',{view:{kind:'thread list'}},'command')
  if(cmd?.action!=='open_app_route')throw Error('Bare music did not use its declared route: '+JSON.stringify(cmd))
  let admitted=false
  const remove=window.WosFeatures.register({id:'qa-music-route',run:H=>{admitted=H.command('music',{view:{kind:'thread list'}})}})
  window.WosFeatures.open('qa-music-route');remove()
  if(!admitted)throw Error('Shell did not open the Music route')
  if(document.querySelector('iframe[data-voice-service="wizard-music"]'))throw Error('Music still has a hidden voice receiver')
  return cmd.action
 },shell)
 const visible=page.locator('iframe:not([data-voice-service])[src*="/wizard-music/"]:visible').last()
 await visible.waitFor({state:'visible'})
 const frame=await (await visible.elementHandle()).contentFrame()
 if(playlistOnly){
  rows.push(await checkPlaylists({page,frame,shell,skin,out,settle,APP}))
  assert.deepEqual(errors,[]);assert.deepEqual(routeErrors,[])
  fs.writeFileSync(path.join(out,'browser-progress.json'),JSON.stringify({complete:false,rows},null,2))
  await closeContext(context);continue
 }
 if(localOnly){
  const id=await frame.evaluate(()=>localStorage.getItem('qa.local.id'))
  const read=()=>frame.evaluate(async id=>{const d=await new Promise((res,rej)=>{const r=indexedDB.open('trackhunt-offline-v1',1);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const row=await new Promise(res=>{const q=d.transaction('captures').objectStore('captures').get(id);q.onsuccess=()=>res(q.result)});d.close();if(!row)return null;return {...row,blob:undefined,size:row.blob.size,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await row.blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('')}},id)
  await frame.locator('.identify-hunt').filter({hasText:'Not sent · tap to review'}).waitFor()
  const original=await read();assert.equal(original.sendRequested,false)
  checkpoint('local-original',{shell,skin,row:original})
  const baselinePosts=()=>netLines.filter(s=>s.includes(' POST ')&&!s.includes(' RES ')).length
  const beforePosts=baselinePosts(),beforeAcks=await acks(frame)
  await frame.locator('.identify-hunt').filter({hasText:'Not sent · tap to review'}).click()
  await frame.getByText('Not sent. You can review or send it below.',{exact:true}).waitFor()
  await frame.getByRole('button',{name:'Discard',exact:true}).waitFor()
  await frame.getByRole('button',{name:'Send for identification',exact:true}).waitFor()
  await frame.waitForFunction(()=>document.querySelector('dialog audio')?.duration>=6.9)
  const sheetColor=await frame.locator('dialog').evaluate(d=>getComputedStyle(d).backgroundColor)
  assert.ok(!sheetColor.startsWith('rgba('),'opaque existing shared sheet')
  const beforeColor=await frame.locator('dialog').evaluate(d=>getComputedStyle(d).color)
  await page.evaluate(s=>window.WosSkin.set(s),skin==='nebula'?'grove':'nebula')
  await frame.waitForFunction(c=>getComputedStyle(document.querySelector('dialog')).color!==c,beforeColor)
  await page.evaluate(s=>window.WosSkin.set(s),skin)
  await frame.waitForFunction(c=>getComputedStyle(document.querySelector('dialog')).color===c,beforeColor)
  await settle(frame,'dialog[open]')
  const sheetImage=path.join(out,`${shell}-${skin}-local-unsent-discard.png`);await page.screenshot({path:sheetImage})
  // Hold the actual localStore database-open dependency, before its write transaction starts.
  await frame.evaluate(()=>{
   const open=indexedDB.open.bind(indexedDB);window.__qaHoldLocal=true
   indexedDB.open=(...args)=>{const r=open(...args);return {get result(){return r.result},get error(){return r.error},set onupgradeneeded(fn){r.onupgradeneeded=fn},set onerror(fn){r.onerror=fn},set onsuccess(fn){r.onsuccess=e=>{if(window.__qaHoldLocal&&args[0]==='trackhunt-offline-v1'){window.__qaHoldLocal=false;window.__qaLocalHeld=true;window.__qaReleaseLocal=()=>{window.__qaLocalHeld=false;fn(e)}}else fn(e)}}}}
  })
  const beforeCount=await frame.locator('.identify-history .identify-hunt').count()
  const immediate=await frame.getByRole('button',{name:'Discard',exact:true}).evaluate(async b=>{const t=performance.now();b.click();b.click();const syncClosed=!document.querySelector('dialog[open]');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {syncClosed,ms:performance.now()-t,rows:document.querySelectorAll('.identify-history .identify-hunt').length,held:window.__qaLocalHeld,undo:document.querySelector('.identify-notice')?.textContent.includes('Undo')}})
  assert.ok(immediate.syncClosed&&immediate.held&&immediate.undo);assert.ok(immediate.ms<100,JSON.stringify(immediate));assert.equal(immediate.rows,beforeCount-1)
  await frame.getByRole('button',{name:'Refresh identifications'}).click()
  await frame.waitForTimeout(300)
  assert.equal(await frame.locator('.identify-hunt').filter({hasText:'Not sent · tap to review'}).count(),0)
  assert.equal(baselinePosts(),beforePosts);assert.equal(await acks(frame),beforeAcks)
  const noticeImage=path.join(out,`${shell}-${skin}-local-discard-undo.png`);await page.screenshot({path:noticeImage})
  await frame.evaluate(()=>window.__qaReleaseLocal())
  checkpoint('local-write-released',{shell,skin,immediate})
  await frame.waitForFunction(async id=>{const d=await new Promise(res=>{const r=indexedDB.open('trackhunt-offline-v1',1);r.onsuccess=()=>res(r.result)});const row=await new Promise(res=>{const q=d.transaction('captures').objectStore('captures').get(id);q.onsuccess=()=>res(q.result)});d.close();return !!row?.discardedAt},id)
  const removed=await read();assert.equal(removed.hash,original.hash);assert.equal(removed.id,id);assert.equal(removed.sendRequested,false)
  checkpoint('local-tombstone',{shell,skin,row:removed})
  await frame.goto(ORIGIN+'/wizard-music/?view=identify')
  checkpoint('local-reloaded',{shell,skin})
  await frame.getByRole('button',{name:'Undo',exact:true}).waitFor()
  await frame.evaluate(()=>dispatchEvent(new Event('online')))
  await frame.getByRole('button',{name:'Refresh identifications'}).click()
  await frame.waitForTimeout(12000) // six normal poll boundaries with shared pending replay
  assert.equal(await frame.locator('.identify-hunt').filter({hasText:'Not sent · tap to review'}).count(),0)
  assert.equal(baselinePosts(),beforePosts);assert.equal(await acks(frame),beforeAcks)
  await frame.getByRole('button',{name:'Undo',exact:true}).click()
  checkpoint('local-undo-clicked',{shell,skin})
  await frame.getByText('Clip restored · not sent',{exact:true}).waitFor()
  const restored=await read();checkpoint('local-restored',{shell,skin,row:restored});assert.deepEqual(restored,original)
  await frame.getByRole('button',{name:'Refresh identifications'}).click();await frame.waitForTimeout(300)
  assert.equal(baselinePosts(),beforePosts);assert.equal(await acks(frame),beforeAcks)
  await frame.locator('.identify-hunt').filter({hasText:'Not sent · tap to review'}).click()
  await frame.getByText('Not sent. You can review or send it below.',{exact:true}).waitFor()
  await frame.getByRole('button',{name:'Send for identification',exact:true}).click()
  checkpoint('local-manual-send',{shell,skin})
  await waitAcks(frame,beforeAcks+1,'Manual Send after local Undo')
  assert.equal(baselinePosts(),beforePosts+1)
  const stored=await(await fetch(APP+'/wizard-music/api/identify/captures/'+id)).json();assert.equal(stored.id,id);assert.equal(stored.raw_sha256,original.hash)
  assert.equal(await read(),null)
  rows.push({shell,skin,persisted_unsent:true,discard_same_frame:immediate,no_upload_or_ack_before_manual_send:true,shared_replay_reload_hidden:true,undo_same_uuid_blob_unsent:true,manual_send_durable_readback_before_ack:true,pageerrors:errors,screenshots:[sheetImage,noticeImage]})
  fs.writeFileSync(path.join(out,'browser-progress.json'),JSON.stringify({complete:false,rows},null,2))
  assert.deepEqual(routeErrors,[]);await closeContext(context);continue
 }
 await frame.getByRole('progressbar',{name:'Audio capture target'}).waitFor({state:'visible'})
 const settles={}
 // Desktop showed the shell's own screen through Music's glass: the hosted app root must be an opaque surface.
 const rootBg=await frame.evaluate(()=>getComputedStyle(document.getElementById('root')).backgroundColor)
 const rootAlpha=(m=>m?Number(m[1]??1):0)(rootBg.match(/^rgba?\([^,]+,[^,]+,[^,)]+(?:,\s*([\d.]+))?\)$/))
 if(rootAlpha<1)throw Error('Hosted Music root lets the shell show through in '+skin+': '+rootBg)
 const beforeColor=await frame.locator('.identify-view').evaluate(el=>getComputedStyle(el).color)
 await page.evaluate(s=>window.WosSkin.set(s),skin==='nebula'?'grove':'nebula')
 await frame.waitForFunction(prior=>getComputedStyle(document.querySelector('.identify-view')).color!==prior,beforeColor)
 await page.evaluate(s=>window.WosSkin.set(s),skin)
 await frame.waitForFunction(prior=>getComputedStyle(document.querySelector('.identify-view')).color===prior,beforeColor)
 // The recording pane can still be sliding in (Grove phone was caught ~107px across): settle before the raster.
 settles.recording=await atTop(frame,'.identify-orb-wrap')
 const recordingImage=path.join(out,`${shell}-${skin}-identify-recording.png`)
 await page.screenshot({path:recordingImage})
 await frame.getByRole('button',{name:/^Find it/}).click()
 await frame.locator('dialog[open]').waitFor()
 // The clip's sheet opens on the tap itself, before saving or any upload.
 await frame.getByRole('heading',{name:/Identification/,exact:false}).last().waitFor()
 settles.waiting=await settle(frame,'dialog[open]')
 const waitingImage=path.join(out,`${shell}-${skin}-identify-waiting.png`)
 await page.screenshot({path:waitingImage})
 await waitAcks(frame,1,'Upload after Find it')
 if(discardOnly){
  await frame.getByRole('button',{name:'Discard',exact:true}).waitFor({timeout:20000})
  const cid=await frame.locator('dialog audio').first().evaluate(a=>new URL(a.src).pathname.split('/').at(-2))
  const target=`${APP}/wizard-music/api/identify/captures/${cid}`
  const original=await (await fetch(target)).json()
  assert.equal(original.status,'no_match')
  const beforeCount=await frame.locator('.identify-history .identify-hunt').count()
  await frame.getByRole('button',{name:'Discard',exact:true}).scrollIntoViewIfNeeded()
  await settle(frame,'dialog[open]')
  const sheetImage=path.join(out,`${shell}-${skin}-discard-action.png`);await page.screenshot({path:sheetImage})
  let release, posts=0, held=true
  const gate=new Promise(r=>{release=r})
  await context.route(`**/wizard-music/api/identify/captures/${cid}/discard`,async route=>{
   posts++;if(held)await gate
   const r=await context.request.fetch(target+'/discard',{method:'POST',headers:{'content-type':'application/json'},data:'{}'})
   await route.fulfill({status:r.status(),headers:r.headers(),body:await r.body()})
  })
  const immediate=await frame.getByRole('button',{name:'Discard',exact:true}).evaluate(async button=>{
   const before=performance.now();button.click();button.click()
   const syncClosed=!document.querySelector('dialog[open]')
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
   return {syncClosed,ms:performance.now()-before,rows:document.querySelectorAll('.identify-history .identify-hunt').length,undo:!!document.querySelector('.identify-notice')}
  })
  assert.ok(immediate.syncClosed&&immediate.undo);assert.ok(immediate.ms<100,JSON.stringify(immediate));assert.equal(immediate.rows,beforeCount-1)
  const noticeImage=path.join(out,`${shell}-${skin}-discard-undo.png`);await page.screenshot({path:noticeImage})
  held=false;release()
  await frame.waitForFunction(async id=>(await (await fetch('/wizard-music/api/identify/captures/'+id)).json()).retention_state==='discarded',cid)
  assert.equal(posts,1,'double tap is one discard request')
  await frame.getByRole('button',{name:'Undo',exact:true}).click()
  await frame.getByText('Identification restored',{exact:true}).waitFor()
  const restored=await (await fetch(target)).json()
  assert.equal(restored.retention_state,'active');assert.equal(restored.id,cid)
  assert.deepEqual(restored.attempts,original.attempts);assert.deepEqual(restored.candidates,original.candidates);assert.equal(restored.raw_sha256,original.raw_sha256)
  assert.equal(await frame.locator('.identify-history .identify-hunt').count(),beforeCount)
  // Discard once more then cold-reload this app, without restarting its listen route.
  const targetRow=frame.locator('.identify-history .identify-hunt').filter({hasText:'Unknown song'}).first()
  // This capture is newest; the API list uses that same creation-time ordering.
  await targetRow.click();await frame.getByRole('button',{name:'Discard',exact:true}).click()
  await frame.waitForFunction(async id=>(await (await fetch('/wizard-music/api/identify/captures/'+id)).json()).retention_state==='discarded',cid)
  await frame.goto(ORIGIN+'/wizard-music/?view=identify')
  await frame.getByRole('heading',{name:'Identifications',exact:true}).waitFor()
  await frame.waitForFunction(n=>document.querySelectorAll('.identify-history .identify-hunt').length===n,beforeCount-1)
  const listed=await (await fetch(APP+'/wizard-music/api/identify/captures')).json()
  assert.ok(!listed.captures.some(c=>c.id===cid))
  assert.equal((await (await fetch(target)).json()).raw_sha256,original.raw_sha256)
  rows.push({shell,skin,discard_same_frame:immediate,undo_real_readback:true,reload_hidden:true,audio_attempts_candidates_preserved:true,pageerrors:errors,screenshots:[sheetImage,noticeImage]})
  fs.writeFileSync(path.join(out,'browser-progress.json'),JSON.stringify({complete:false,rows},null,2))
  assert.deepEqual(routeErrors,[]);await closeContext(context);continue
 }
 settles.results=await settle(frame,'dialog[open]')
 const resultsImage=path.join(out,`${shell}-${skin}-identify-results.png`)
 await page.screenshot({path:resultsImage})
 assert.match(await frame.locator('dialog[open]').innerText(),/Finding your track|No match|Possible matches/)
 await page.evaluate(el=>window.WizAppServices.back(el),await visible.elementHandle())
 await frame.waitForFunction(()=>!document.querySelector('dialog[open]'))
 // Open imported hunt and verify media really decodes. History sits under the Identify stage (James's Shazam-like redesign).
 await frame.getByRole('heading',{name:'Identifications',exact:true}).waitFor()
 assert.ok(await frame.getByRole('button',{name:'Identify song',exact:true}).isVisible(),'one large Identify control on the idle stage')
 settles.idle=await atTop(frame,'.identify-stage button.identify-orb')
 const idleImage=path.join(out,`${shell}-${skin}-identify-idle.png`)
 await page.screenshot({path:idleImage})
 const row=frame.locator('.identify-hunt').filter({hasText:hunt.best_title}).first()
 await row.click()
 await frame.locator('dialog[open]').waitFor()
 await frame.waitForFunction(()=>{const a=document.querySelector('dialog audio');return a&&a.readyState>=1&&a.duration>0})
 await frame.waitForTimeout(400) // let the sheet's open animation finish before judging it
 const sheetBg=await frame.evaluate(()=>getComputedStyle(document.querySelector('dialog[open]')).backgroundColor)
 const alpha=(m=>m?Number(m[1]??1):0)(sheetBg.match(/^rgba?\([^,]+,[^,]+,[^,)]+(?:,\s*([\d.]+))?\)$/))
 if(alpha<1)throw Error('Hunt sheet is not fully opaque in '+skin+': '+sheetBg)
 const sheetImage=path.join(out,`${shell}-${skin}-identify-sheet.png`)
 await page.screenshot({path:sheetImage})
 // A physical click on the iframe backdrop closes the shared sheet.
 const box=await visible.boundingBox();await page.mouse.click(box.x+5,box.y+5)
 await frame.waitForFunction(()=>!document.querySelector('dialog[open]'))
 await row.click();await frame.locator('dialog[open]').waitFor()
 // Back closes detail, then list, then stays in Music (never exits the frame).
 const back1=await page.evaluate(el=>window.WizAppServices.back(el),await visible.elementHandle())
 await frame.waitForFunction(()=>!document.querySelector('dialog[open]'))
 const back2=await page.evaluate(el=>window.WizAppServices.back(el),await visible.elementHandle())
 const listClosed=await frame.waitForFunction(()=>!document.querySelector('.identify-view'),null,{timeout:5000}).then(()=>true,()=>false)
 if(!listClosed)throw Error('Second Back did not leave the Hunts list: '+JSON.stringify({back1,back2,dialogs:await frame.evaluate(()=>document.querySelectorAll('dialog').length)})+' '+await dump(frame,'back-list'))
 assert.ok(await visible.isVisible())
 // Music home: one Identify entry with Identifications beside it, no duplicated top button row.
 await frame.locator('.identify-entry').waitFor({state:'visible'})
 assert.equal(await frame.getByRole('button',{name:/^Identifications/}).count(),1,'one Identifications link on home')
 // Earlier home captures were left scrolled into the library by the hunt-row click; judge the real top of home.
 const homeTop=await atTop(frame,'.identify-entry')
 const homeImage=path.join(out,`${shell}-${skin}-music-home.png`)
 await page.screenshot({path:homeImage})
 // Held permission paints starting immediately, then offline stop persists without ack.
 await frame.evaluate(()=>{window.__qaHold=true})
 await frame.getByRole('button',{name:'Identify song',exact:true}).click()
 await frame.getByText('Starting microphone…',{exact:true}).waitFor()
 assert.equal(await frame.evaluate(()=>window.__qaStarts.length),2)
 await frame.evaluate(()=>{window.__qaHold=false;window.__qaResolve()})
 await frame.getByRole('progressbar',{name:'Audio capture target'}).waitFor()
 offline=true
 await frame.getByRole('button',{name:/^Find it/}).click()
 await frame.locator('dialog[open]').waitFor()
 // "Sending your clip…" paints before the upload is tried; reconnect only once an offline upload was really refused.
 await frame.getByText('Saved on this device',{exact:true}).first().waitFor()
 for(const end=Date.now()+10000;!refusedPosts&&Date.now()<end;)await new Promise(r=>setTimeout(r,100))
 assert.ok(refusedPosts>=1,'the offline Send really attempted an upload and was refused')
 assert.equal(await acks(frame),1)
 offline=false
 await frame.evaluate(()=>dispatchEvent(new Event('online')))
 await waitAcks(frame,2,'Reconnect upload')
 await page.evaluate(el=>window.WizAppServices.back(el),await visible.elementHandle())
 await frame.waitForFunction(()=>!document.querySelector('dialog[open]'))
 await frame.getByRole('heading',{name:'Identifications',exact:true}).waitFor()
 const listImage=path.join(out,`${shell}-${skin}-identify-hunts.png`)
 await page.screenshot({path:listImage})
 rows.push({shell,skin,priority_bare_music:command,legacy_audio_decoded:true,back_sheet_list_home:true,held_permission_same_frame:true,offline_saved_reconnected:true,home_top:homeTop,settled:settles,screenshots:[homeImage,idleImage,recordingImage,waitingImage,resultsImage,sheetImage,listImage],pageerrors:errors})
 fs.writeFileSync(path.join(out,'browser-progress.json'),JSON.stringify({complete:false,rows},null,2))
 assert.deepEqual(routeErrors,[]);await closeContext(context)
}
} catch(error) {
 const failure={step:currentStep,error:error.stack||error.message,routeErrors,diagnostic:await diagnostic?.().catch(e=>({error:e.message}))}
 fs.writeFileSync(path.join(out,'browser-failure.json'),JSON.stringify(failure,null,2));console.error('PRIMARY BROWSER FAILURE',JSON.stringify(failure,null,2));throw error
} finally {if(activeContext)await closeContext(activeContext);await browser.close()}
fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify({ok:true,capture:'synthetic shared-capture port; real handset remains owner test',rows},null,2))
console.log(JSON.stringify({ok:true,rows},null,2))
