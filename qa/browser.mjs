// Run on the designated worker. Real container + shared platform client, not mocked APIs.
import { createServer, request } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
const [target, core, out] = process.argv.slice(2)
await mkdir(out,{recursive:true})
const checks=[], errors=[]
const server=createServer(async(req,res)=>{
 if(req.url==='/qa-host'){res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html><head><style>html,body{margin:0;height:100%;background:var(--bg);color:var(--ink)}.win{height:90vh;background:var(--sk-win)}iframe{width:100%;height:100%;border:0}.immersive .win{height:100vh}</style></head><body><div class="device"><div class="win"><iframe src="/wizard-music/"></iframe></div></div><script>window.WizCore={apps:()=>({APPS:[{url:'/wizard-music/'}]})}</script><script src="/qa-core/skins.js"></script><script src="/qa-core/appearance-host.js"></script></body></html>`);return}
 if(['/qa-core/skins.js','/qa-core/appearance-host.js'].includes(req.url)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(join(dirname(core),req.url.split('/').pop())));return}
 if(req.url==='/wizard-os-home/core/app-client.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(core));return}
 const up=request({hostname:'127.0.0.1',port:Number(target),path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:9205'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});up.on('error',()=>{res.writeHead(502);res.end()});req.pipe(up)
})
await new Promise(r=>server.listen(19325,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--autoplay-policy=no-user-gesture-required']})
try {
 const page=await browser.newPage({viewport:{width:390,height:844}})
 page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(()=>{const RealAudio=window.Audio;window.Audio=class extends RealAudio {constructor(...args){super(...args);window.__qaAudio=this}}})
 await page.goto('http://127.0.0.1:19325/wizard-music/')
 await page.getByRole('heading',{name:'On your Wizard'}).waitFor()
 checks.push('configured library visible')
 await page.screenshot({path:out+'/library-mobile.png',fullPage:true})
 await page.getByRole('button',{name:'Shuffle',exact:true}).click()
 await page.waitForFunction(()=>window.__qaAudio && !window.__qaAudio.paused && window.__qaAudio.currentTime>5,{},{timeout:20000})
 const audio=await page.evaluate(()=>({time:window.__qaAudio.currentTime,duration:window.__qaAudio.duration,readyState:window.__qaAudio.readyState,paused:window.__qaAudio.paused,currentSrc:window.__qaAudio.currentSrc,decodedBytes:window.__qaAudio.webkitAudioDecodedByteCount||null}))
 assert(audio.time>5 && audio.readyState>=2 && !audio.paused)
 checks.push('real mounted WAV decoded and audio clock advanced >5 seconds')
 await page.screenshot({path:out+'/playing-mobile.png',fullPage:true})
 await page.getByRole('button',{name:'Pause',exact:true}).last().click()
 assert(await page.evaluate(()=>window.__qaAudio.paused));checks.push('pause stops real media')
 await page.evaluate(()=>history.back())
 await page.waitForFunction(()=>!document.querySelector('.music-now'))
 assert(page.url().includes('/wizard-music/'));checks.push('nested browser Back retains app')
 await page.getByRole('button',{name:/Open player:/}).click()
 await page.getByRole('button',{name:'Close player'}).click()
 checks.push('on-screen close retains app')
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('wizard-music.session.v1')))
 assert(saved?.queue.length && saved.positionMs>3000 && saved.playing===false)
 await page.reload()
 await page.getByRole('button',{name:/Open player:/}).waitFor()
 assert(await page.evaluate(()=>window.__qaAudio.paused));checks.push('reload restores track and paused intention')
 await page.getByRole('button',{name:'Play',exact:true}).click()
 await page.waitForFunction(()=>!window.__qaAudio.paused && window.__qaAudio.currentTime>6)
 checks.push('resume after reload advances media')
 await page.getByRole('button',{name:'Pause',exact:true}).click()
 await page.getByRole('searchbox',{name:'Search music'}).fill('Recipient QA')
 await page.getByRole('searchbox',{name:'Search music'}).press('Enter')
 await page.getByRole('heading',{name:/Results for/}).waitFor()
 assert(await page.locator('.music-results .music-row').count()>0);checks.push('search returns configured local track without autoplay')
 assert(await page.evaluate(()=>window.__qaAudio.paused))
 await page.evaluate(()=>history.back())
 await page.waitForTimeout(200)
 assert(page.url().includes('/wizard-music/'));checks.push('single root Back retains app')
 await page.setViewportSize({width:1280,height:900})
 await page.screenshot({path:out+'/desktop.png',fullPage:true})
 // Real approved Appearance host/client with a bounded registered-frame fixture,
 // not a claim of a production shell/store installation.
 await page.goto('http://127.0.0.1:19325/qa-host')
 const frame=page.frameLocator('iframe')
 await frame.getByRole('heading',{name:'On your Wizard'}).waitFor()
 for(const skin of ['nebula','grove','tide','ember','signal']){
  await page.evaluate(s=>window.WosSkin.set(s),skin)
  await page.waitForFunction(s=>document.querySelector('iframe').contentDocument.documentElement.dataset.skin===s,skin)
  assert(await frame.locator('.music-shell-head').isHidden())
  assert(await frame.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor)==='rgba(0, 0, 0, 0)')
  await page.screenshot({path:out+'/embedded-'+skin+'.png',fullPage:true})
 }
 checks.push('five accepted skins through actual shared appearance host/client; transparent canvas and no duplicate title')
 await page.evaluate(()=>{document.querySelector('.device').classList.add('immersive');document.querySelector('.win').classList.add('full')})
 await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.documentElement.dataset.presentation==='immersive')
 await frame.getByRole('button',{name:'Shuffle',exact:true}).click()
 await frame.getByRole('dialog',{name:'Now playing'}).waitFor()
 await page.waitForTimeout(1000)
 await page.screenshot({path:out+'/embedded-fullscreen.png',fullPage:true})
 checks.push('embedded full-screen Now Playing opens and retains shared appearance')
 assert(errors.length===0,JSON.stringify(errors))
 checks.push('no uncaught browser errors')
 const result={ok:true,scope:'Browser fallback in loopback gateway using approved shared app-client; not full production shell or native Android',audio,checks,errors}
 await writeFile(out+'/browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
} catch(e){console.error(e);process.exitCode=1} finally {await browser.close();server.close()}
