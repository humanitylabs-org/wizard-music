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
start:async options=>{window.__qaStarts.push(options);if(window.__qaHold)await new Promise((r,j)=>{window.__qaResolve=r;window.__qaReject=j});const id=crypto.randomUUID(),startedAt=Date.now();return {id,onLevel:fn=>{fn(.45);return()=>{}},stop:async()=>({id,startedAt,durationMs:1200,mime:'audio/wav',meta:options.meta,blob:new Blob([Uint8Array.from(atob(${JSON.stringify(wav)}),c=>c.charCodeAt(0))],{type:'audio/wav'})})}},pending:async()=>[],ack:async id=>{window.__qaAcks.push(id);return true}
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
 await page.goto(ORIGIN+'/wizard-os-home/'+(shell==='phone'?'?shell=phone':'desktop.html'),{waitUntil:'load'})
 await page.waitForFunction(([sh,sk])=>document.documentElement.dataset.shell===sh&&document.documentElement.dataset.skin===sk,[shell,skin])
 await page.waitForFunction(()=>window.WizAppServices?.inspect().some(x=>x.appId==='wizard-music'&&x.ready))
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
 await frame.getByRole('button',{name:'Stop and identify',exact:true}).click()
 await frame.waitForFunction(()=>window.__qaAcks.length===1)
 // Open imported hunt and verify media really decodes.
 await frame.getByRole('button',{name:'Hunts',exact:true}).click()
 const row=frame.locator('.identify-hunt').filter({hasText:hunt.best_title}).first()
 await row.click()
 await frame.locator('dialog[open]').waitFor()
 await frame.waitForFunction(()=>{const a=document.querySelector('dialog audio');return a&&a.readyState>=1&&a.duration>0})
 const sheetImage=path.join(out,`${shell}-${skin}-identify-sheet.png`)
 await page.screenshot({path:sheetImage})
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
 assert.equal(await frame.evaluate(()=>window.__qaAcks.length),1)
 offline=false
 await frame.evaluate(()=>dispatchEvent(new Event('online')))
 await frame.waitForFunction(()=>window.__qaAcks.length===2)
 await frame.getByRole('button',{name:'Hunts',exact:true}).click()
 const listImage=path.join(out,`${shell}-${skin}-identify-hunts.png`)
 await page.screenshot({path:listImage})
 rows.push({shell,skin,priority_bare_music:command,legacy_audio_decoded:true,back_sheet_list_home:true,held_permission_same_frame:true,offline_saved_reconnected:true,screenshots:[sheetImage,listImage],pageerrors:errors})
 await context.close()
}
} finally {await browser.close()}
fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify({ok:true,capture:'synthetic shared-capture port; real handset remains owner test',rows},null,2))
console.log(JSON.stringify({ok:true,rows},null,2))
