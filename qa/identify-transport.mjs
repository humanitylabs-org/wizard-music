import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createMusicProxy,musicRoute} from '../server/music.mjs'
const cid='a40a2a22-c187-4791-ae34-90c00628b089'
const listen=async fn=>{const s=createServer(fn);await new Promise(r=>s.listen(0,'127.0.0.1',r));return {server:s,origin:`http://127.0.0.1:${s.address().port}`,close:()=>new Promise(r=>{s.closeAllConnections();s.close(r)})}}
const json=(r,status,value)=>{r.writeHead(status,{'content-type':'application/json'});r.end(JSON.stringify(value))}
test('Identify allowlist, raw audio, full query, credentials boundary and media Range',async()=>{
 const calls=[]
 const up=await listen(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);calls.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});if(req.url.includes('/audio')){res.writeHead(206,{'content-type':'audio/wav','content-range':'bytes 0-3/10'});res.end('RIFF')}else json(res,200,{audio_url:`/wizard/music/api/identify/captures/${cid}/audio`})})
 const handle=createMusicProxy({origin:up.origin,token:'fixture-hub-only'})
 const app=await listen((req,res)=>handle(req,res,new URL(req.url,'http://local'),json))
 try{
  const query=`?id=${cid}&client_ts=2026-11-06T00%3A00%3A00Z&note=fixture`
  const upload=await fetch(app.origin+'/wizard-music/api/identify/captures'+query,{method:'POST',headers:{'content-type':'audio/wav',cookie:'do-not-forward=1',authorization:'Bearer do-not-forward'},body:Buffer.from([0,1,2,3,254,255])})
  assert.equal(upload.status,200)
  assert.equal((await upload.json()).audio_url,`/wizard-music/api/identify/captures/${cid}/audio`)
  assert.equal(calls[0].url,'/api/identify/captures'+query)
  assert.deepEqual(calls[0].body,Buffer.from([0,1,2,3,254,255]))
  assert.equal(calls[0].headers.authorization,'Bearer fixture-hub-only')
  assert.equal(calls[0].headers.cookie,undefined)
  const audio=await fetch(app.origin+`/wizard-music/api/identify/captures/${cid}/audio?kind=original`,{headers:{range:'bytes=0-3'}})
  assert.equal(audio.status,206);assert.equal(await audio.text(),'RIFF')
  assert.equal(calls[1].headers.range,'bytes=0-3')
  assert.ok(calls[1].url.endsWith('?kind=original'))
  assert.equal(musicRoute('DELETE','/api/identify/captures/'+cid),null)
  for(const action of ['discard','restore']){
   const r=await fetch(app.origin+`/wizard-music/api/identify/captures/${cid}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
   assert.equal(r.status,200);assert.equal(calls.at(-1).url,`/api/identify/captures/${cid}/${action}`)
   assert.equal(calls.at(-1).headers.authorization,'Bearer fixture-hub-only')
   assert.equal(musicRoute('GET',`/api/identify/captures/${cid}/${action}`),null)
  }
  assert.equal(musicRoute('GET','/api/identify/../../hub.env'),null)
 }finally{await app.close();await up.close()}
})
