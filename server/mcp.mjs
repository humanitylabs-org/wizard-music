const tools = [
 ...[ ['identify_list','List active saved song hunts, including unsolved clips; excludes discarded.',{}], ['identify_get','Read a hunt, its candidates and attempts.',{id:{type:'string'}}], ['identify_retry','Retry recognition of a saved clip; preserves its audio.',{id:{type:'string'}}], ['identify_discard','Owner-requested: reversibly hide a finished no-match identification. Keeps audio, attempts and candidates.',{id:{type:'string'}}], ['identify_restore','Undo discard of an unmatched identification; restores the same record.',{id:{type:'string'}}], ['identify_confirm','Owner-approved: mark a candidate This is it, like its full track in Music and count it as a request.',{candidate_id:{type:'integer',minimum:1}}] ].map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}})),
 {name:'playlist_list',description:'Read saved YouTube playlists and long mixes, including their exact original URLs, and (songPlaylists) the owner\'s own song playlists. Not playback history.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'playlist_save',description:'Owner-requested: save a YouTube playlist or long-mix video URL in Music. No playback, download, account playlist or import. Duplicate resources retain the first exact URL and metadata.',inputSchema:{type:'object',properties:{url:{type:'string',maxLength:2048},title:{type:'string',maxLength:2000},author:{type:'string',maxLength:300},authorUrl:{type:'string',maxLength:2048},thumbnail:{type:'string',maxLength:2048}},required:['url'],additionalProperties:false}},
 {name:'music_account_library', description:'Browse connected YouTube playlists and liked songs, read-only; does not sync Wizard taste or start playback.', inputSchema:{type:'object', properties:{kind:{type:'string',enum:['status','playlists','likes','playlist']},id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,160}$'}},required:['kind'],additionalProperties:false}},
 {name:'music_status', description:'Read app configuration status; does not prove upstream connectivity.', inputSchema:{type:'object', properties:{}, additionalProperties:false}},
 {name:'music_home', description:'Read sources, library, liked tracks and recent history.', inputSchema:{type:'object', properties:{}, additionalProperties:false}},
 {name:'music_search', description:'Search configured library and optionally enabled online catalog.', inputSchema:{type:'object', properties:{query:{type:'string',maxLength:200}}, required:['query'], additionalProperties:false}}
]
// Song playlists (wizard-music#39), on for everyone.
const SONG_ID={type:'string',pattern:'^(yt|lib):[A-Za-z0-9_-]{1,40}$'}, LIST_ID={type:'string',pattern:'^[a-f0-9]{24}$'}
const TRACK_IDS={type:'array',items:SONG_ID,maxItems:500,description:'Track ids from music_search, music_home or playlist_get (yt:* and lib:*), in play order.'}
const songTools=[
 {name:'playlist_create',description:'Owner-requested: create a Music playlist of single songs, in order, stored on this Wizard (no YouTube account write). Returns the stored playlist read back, plus skipped ids Music does not know.',inputSchema:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:100},description:{type:'string',maxLength:500},track_ids:TRACK_IDS},required:['name','track_ids'],additionalProperties:false}},
 {name:'playlist_add_tracks',description:'Owner-requested: add songs to a Music playlist (at the end, or at position). Songs already in it stay where they are.',inputSchema:{type:'object',properties:{id:LIST_ID,track_ids:TRACK_IDS,position:{type:'integer',minimum:0}},required:['id','track_ids'],additionalProperties:false}},
 {name:'playlist_remove_tracks',description:'Owner-requested: remove songs from a Music playlist.',inputSchema:{type:'object',properties:{id:LIST_ID,track_ids:TRACK_IDS},required:['id','track_ids'],additionalProperties:false}},
 {name:'playlist_update',description:'Owner-requested: rename a Music playlist, change its description, or set its full song order (track_ids replaces the list).',inputSchema:{type:'object',properties:{id:LIST_ID,name:{type:'string',minLength:1,maxLength:100},description:{type:'string',maxLength:500},track_ids:TRACK_IDS},required:['id'],additionalProperties:false}},
 {name:'playlist_get',description:'Read one Music playlist with its songs in order.',inputSchema:{type:'object',properties:{id:LIST_ID},required:['id'],additionalProperties:false}},
]
const SONG_ID_RE=/^(yt|lib):[A-Za-z0-9_-]{1,40}$/, LIST_ID_RE=/^[a-f0-9]{24}$/
/** The hub request for a song-playlist tool, or null when the arguments are invalid. */
export function songPlaylistRequest(name,a){
 if(!a||typeof a!=='object'||Array.isArray(a)) return null
 const tool=songTools.find(t=>t.name===name); if(!tool) return null
 const props=tool.inputSchema.properties
 if(Object.keys(a).some(k=>!Object.hasOwn(props,k))||tool.inputSchema.required.some(k=>a[k]===undefined)) return null
 if(a.id!==undefined&&(typeof a.id!=='string'||!LIST_ID_RE.test(a.id))) return null
 if(a.track_ids!==undefined&&(!Array.isArray(a.track_ids)||a.track_ids.length>500||a.track_ids.some(t=>typeof t!=='string'||!SONG_ID_RE.test(t)))) return null
 if(a.name!==undefined&&(typeof a.name!=='string'||!a.name.trim()||a.name.length>100)) return null
 if(a.description!==undefined&&(typeof a.description!=='string'||a.description.length>500)) return null
 if(a.position!==undefined&&(!Number.isSafeInteger(a.position)||a.position<0)) return null
 const body={...(a.name!==undefined?{name:a.name}:{}),...(a.description!==undefined?{description:a.description}:{}),...(a.track_ids!==undefined?{trackIds:a.track_ids}:{}),...(a.position!==undefined?{position:a.position}:{})}
 if(name==='playlist_get') return {path:'/'+a.id}
 if(name==='playlist_create') return {path:'',body}
 if(name==='playlist_update') return Object.keys(body).length?{path:'/'+a.id,body}:null
 return {path:'/'+a.id+(name==='playlist_add_tracks'?'/add':'/remove'),body}
}
// More like this stations (wizard-music#90, switch curated-radio): listed and callable only while the switch is on.
const curateTool={name:'station_curate',description:'Owner-requested: start a "more like this" station in Music from one song: the owner\'s AI writes a sound profile of it and Music queues matching songs it can really play. Give track_id (from music_search or music_home) or query ("Trap Gui Boratto"), and note with the owner\'s own words about what they love in it. Returns the station title, its profile, the first 10 tracks read back from Music and an open link that plays it in Music; give the owner that link.',inputSchema:{type:'object',properties:{track_id:SONG_ID,query:{type:'string',minLength:1,maxLength:200},note:{type:'string',maxLength:500}},additionalProperties:false}}
/** The hub body for station_curate, or null when the arguments are invalid. */
export function curateRequest(a){
 if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['track_id','query','note'].includes(k))) return null
 if(a.track_id!==undefined&&(typeof a.track_id!=='string'||!SONG_ID_RE.test(a.track_id))) return null
 if(a.query!==undefined&&(typeof a.query!=='string'||!a.query.trim()||a.query.length>200)) return null
 if(a.note!==undefined&&(typeof a.note!=='string'||a.note.length>500)) return null
 if(!a.track_id===!a.query) return null   // exactly one of track_id or query
 return {curate:true,...(a.track_id?{trackId:a.track_id}:{query:a.query.trim()}),...(a.note?{note:a.note}:{})}
}
export async function handleMcp(req,res,send,port,{curated=false}={}) {
 if(req.method !== 'POST') { send(res,405,{error:'method'}); return }
 if(!String(req.headers['content-type']).startsWith('application/json')) {send(res,415,{error:'json_required'});return}
 let size=0, chunks=[]
 for await(const c of req) {size+=c.length;if(size>65536){send(res,413,{error:'too_large'});return}chunks.push(c)}
 let m;try{m=JSON.parse(Buffer.concat(chunks))}catch{send(res,400,{error:'invalid_json'});return}
 if(!m || Array.isArray(m) || m.jsonrpc!=='2.0'){send(res,400,{error:'invalid_request'});return}
 if(m.id===undefined){res.writeHead(202);res.end();return}
 const answer=result=>send(res,200,{jsonrpc:'2.0',id:m.id,result})
 if(m.method==='initialize'){answer({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'wizard-music',version:'0.1.0'}});return}
 if(m.method==='ping'){answer({});return}
 if(m.method==='tools/list'){answer({tools:[...tools,...songTools,...(curated?[curateTool]:[])]});return}
 if(m.method!=='tools/call'){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});return}
 const name=m.params?.name, a=m.params?.arguments||{}
 if(name==='station_curate'&&curated){
  const body=curateRequest(a)
  if(!body){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Give track_id or query (one of them), and optionally note'}});return}
  const base=`http://127.0.0.1:${port}/wizard-music/api/station`
  try{
   const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150000)})
   const started=await r.json().catch(()=>({}))
   if(!r.ok||!started.station?.id){answer({content:[{type:'text',text:JSON.stringify(started)}],isError:true});return}
   // Read back what Music will really play: the seed, then the next 10 (waits for the AI's picks).
   const back=await fetch(`${base}/${started.station.id}?wait=1`,{signal:AbortSignal.timeout(150000)}), view=await back.json()
   const row=t=>({id:t.id,title:t.title,artist:t.artist})
   answer({content:[{type:'text',text:JSON.stringify({station:{id:view.station.id,title:view.station.title,profile:view.station.profile||'',picks:view.station.picks},seed:view.seed&&row(view.seed),tracks:(view.tracks||[]).slice(0,10).map(row),open:`/wizard-music/?station=${view.station.id}`})}],isError:!back.ok})
  }catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
  return
 }
 if(songTools.some(t=>t.name===name)){
  const call=songPlaylistRequest(name,a)
  if(!call){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid playlist arguments'}});return}
  const base=`http://127.0.0.1:${port}/wizard-music/api/song-playlists`
  try{
   const r=await fetch(base+call.path,{...(call.body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(call.body)}:{}),signal:AbortSignal.timeout(150000)})
   const text=await r.text()
   if(!r.ok||!call.body){answer({content:[{type:'text',text}],isError:!r.ok});return}
   // Read back after every write, so the agent reports what is really stored.
   const written=JSON.parse(text), back=await fetch(base+'/'+written.id,{signal:AbortSignal.timeout(150000)})
   answer({content:[{type:'text',text:JSON.stringify({playlist:await back.json(),skipped:written.skipped||[]})}],isError:!back.ok})
  }catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
  return
 }
 if(name==='playlist_list'||name==='playlist_save'){
  const write=name==='playlist_save'
  const allowed=['url','title','author','authorUrl','thumbnail']
  if(!a||Array.isArray(a)||typeof a!=='object'||Object.keys(a).some(k=>!allowed.includes(k))||(!write&&Object.keys(a).length)||(write&&(typeof a.url!=='string'||Object.values(a).some(v=>typeof v!=='string')))){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid playlist arguments'}});return}
  try{
   const r=await fetch(`http://127.0.0.1:${port}/wizard-music/api/playlists`,{...(write?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a)}:{}),signal:AbortSignal.timeout(150000)})
   let text=await r.text()
   // The list also carries the owner's own song playlists (songPlaylists).
   if(!write&&r.ok){const s=await fetch(`http://127.0.0.1:${port}/wizard-music/api/song-playlists`,{signal:AbortSignal.timeout(150000)});if(s.ok)text=JSON.stringify({...JSON.parse(text),songPlaylists:(await s.json()).playlists})}
   answer({content:[{type:'text',text}],isError:!r.ok})
  }catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
  return
 }
 const identifyTool=name?.startsWith('identify_')
 if(identifyTool){
  const id=typeof a.id==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.id)?a.id:null
  const candidate=Number.isSafeInteger(a.candidate_id)&&a.candidate_id>0?a.candidate_id:null
  const route=name==='identify_list'?'captures':name==='identify_get'&&id?'captures/'+id:['identify_retry','identify_discard','identify_restore'].includes(name)&&id?'captures/'+id+'/'+name.slice(9):name==='identify_confirm'&&candidate?'candidates/'+candidate+'/verdict':null
  if(!route){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid identify arguments'}});return}
  const write=['identify_retry','identify_confirm','identify_discard','identify_restore'].includes(name)
  try{const r=await fetch(`http://127.0.0.1:${port}/wizard-music/api/identify/${route}`,{method:write?'POST':'GET',headers:write?{'Content-Type':'application/json'}:{},...(write?{body:JSON.stringify(name==='identify_confirm'?{verdict:'confirmed'}:{})}:{}),signal:AbortSignal.timeout(150000)});answer({content:[{type:'text',text:await r.text()}],isError:!r.ok})}catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
  return
 }
 const paths={music_status:'/wizard-music/api/status',music_home:'/wizard-music/api/home',music_search:'/wizard-music/api/search?q='+encodeURIComponent(typeof a.query==='string'?a.query.slice(0,200):'')}
 if(name==='music_account_library' && ['status','playlists','likes','playlist'].includes(a.kind) && Object.keys(a).every(k=>['kind','id'].includes(k)) && (a.id===undefined || (typeof a.id==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(a.id))) && (a.kind!=='playlist' || typeof a.id==='string')) paths.music_account_library='/wizard-music/api/account-library/'+a.kind+'?'+new URLSearchParams({id:a.id||'',limit:'100'})
 if(!Object.hasOwn(paths,name) || (name==='music_search' && typeof a.query!=='string')){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid tool or arguments'}});return}
 try {const r=await fetch(`http://127.0.0.1:${port}${paths[name]}`,{signal:AbortSignal.timeout(150000)}); answer({content:[{type:'text',text:await r.text()}],isError:!r.ok})}catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
}
