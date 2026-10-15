// Focused hosted-browser fallback; real local-library bytes, deterministic queue.
// Run on Thales: node qa/qa-native-fallback.cjs HTTPS_SHELL_URL OUTPUT_DIR
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const url = process.argv[2], out = process.argv[3], rows = [];
fs.mkdirSync(out, {recursive:true});
const check=(name,ok,detail)=>{rows.push({name,ok:!!ok,detail});console.log(ok?'PASS':'FAIL',name);};
(async()=>{
 const b=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
 try {
  const ctx=await b.newContext({viewport:{width:412,height:892},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36'});
  await ctx.addInitScript(()=>{
    localStorage.setItem('wos.coached','true');
    const A=window.Audio;window.Audio=function(...args){const a=new A(...args);a.style.display='none';(document.body||document.documentElement).appendChild(a);return a;};window.Audio.prototype=A.prototype;
  });
  const p=await ctx.newPage(), errors=[];p.on('pageerror',e=>errors.push(String(e)));
  await p.goto(url);await p.waitForFunction(()=>typeof __wos !== 'undefined' && window.WizCore);await p.evaluate(()=>WizCore.appsLoaded());
  const home=await p.evaluate(()=>fetch('/wizard-music/api/home').then(r=>r.json()));
  const tracks=home.library.slice(0,3);if(tracks.length!==3)throw Error('Requires three real local library tracks');
  await ctx.route(/\/wizard-music\/api\/(play|station)$/,r=>r.fulfill({json:{tracks,index:0,station:null}}));
  await ctx.route('**/wizard-music/api/feedback',r=>r.fulfill({json:{ok:true,track:tracks[0],drop:[]}}));
  await p.evaluate(()=>__wos.openApp(WizCore.apps('mobile').APP['wizard-music']));
  let f;for(let i=0;i<80;i++){f=p.frames().find(x=>x.url().includes('/wizard-music/'));if(f)break;await p.waitForTimeout(250);}
  if(!f)throw Error('Missing Music frame');
  await f.locator('.music-row-main').first().click();
  await f.waitForFunction(()=>{const a=document.querySelector('audio');return a&&!a.paused&&a.currentTime>0.2},{timeout:20000});
  check('ordinary browser selects HTML audio fallback, not native transport',await f.evaluate(()=>!window.WizardNativeMusic&&document.querySelectorAll('audio').length===1));
  await f.locator('.music-now').waitFor();
  await f.getByRole('button',{name:'Next',exact:true}).click();
  await f.waitForFunction(()=>document.querySelector('.music-now-meta h2')?.textContent==='Midnight Kinetic');
  await f.getByRole('button',{name:'Next',exact:true}).click();
  await f.waitForFunction(()=>document.querySelector('.music-now-meta h2')?.textContent==='Soft Focus');
  await f.locator('.music-played-toggle').click();
  const played=await f.locator('.music-played .music-row-text strong').allTextContents();
  check('Played retains the two explicitly skipped songs and current song',played.length===3&&played[0]===tracks[0].title&&played[1]===tracks[1].title&&played[2]===tracks[2].title,played);
  await f.locator('.music-played .music-row-main').first().click();
  await f.waitForFunction(()=>{const a=document.querySelector('audio');return a&&!a.paused&&a.currentTime>0.3});
  check('replay from history restores following queue',await f.locator('.music-upnext > .music-row').count()===2);
  check('shell detects browser music playing',await p.evaluate(()=>WosDevice.mediaPlaying()));
  const before=await f.evaluate(()=>JSON.parse(localStorage.getItem('wizard-music.session.v1')));
  await p.reload();await p.waitForFunction(()=>typeof __wos !== 'undefined' && window.WizCore);await p.evaluate(()=>WizCore.appsLoaded());
  for(let i=0;i<80;i++){f=p.frames().find(x=>x.url().includes('/wizard-music/'));if(f)break;await p.waitForTimeout(250);}
  await f.waitForFunction(()=>{const a=document.querySelector('audio');return a&&!a.paused&&a.currentTime>0.3});
  const after=await f.evaluate(()=>JSON.parse(localStorage.getItem('wizard-music.session.v1')));
  check('shell reload reattaches browser session at same song and position',before.queue[before.index].id===after.queue[after.index].id&&Math.abs(before.positionMs-after.positionMs)<4500,{before:before.positionMs,after:after.positionMs});
  await f.locator('.music-mini-open').click();await f.locator('.music-now').getByRole('button',{name:'Pause',exact:true}).click();
  await f.waitForFunction(()=>document.querySelector('audio').paused);
  await p.waitForFunction(()=>!WosDevice.mediaPlaying(),null,{timeout:5000});
  check('pause clears browser playback and shell busy state',await f.evaluate(()=>document.querySelector('audio').paused)&&!(await p.evaluate(()=>WosDevice.mediaPlaying())));
  await f.getByRole('button',{name:'Close player',exact:true}).click();
  check('closing nested player keeps Wizard and Music open',p.url().includes('/wizard-os-home/')&&await f.locator('.music-mini').isVisible());
  check('no JavaScript errors',!errors.length,errors);
  await p.screenshot({path:path.join(out,'fallback.png')});
 } finally {await b.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(rows,null,2));}
 process.exit(rows.some(r=>!r.ok)?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
