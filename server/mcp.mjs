const tools = [
 ...[ ['identify_list','List active saved song hunts, including unsolved clips; excludes discarded.',{}], ['identify_get','Read a hunt, its candidates and attempts.',{id:{type:'string'}}], ['identify_retry','Retry recognition of a saved clip; preserves its audio.',{id:{type:'string'}}], ['identify_discard','Owner-requested: reversibly hide a finished no-match identification. Keeps audio, attempts and candidates.',{id:{type:'string'}}], ['identify_restore','Undo discard of an unmatched identification; restores the same record.',{id:{type:'string'}}], ['identify_confirm','Owner-approved: mark a candidate This is it, like its full track in Music and count it as a request.',{candidate_id:{type:'integer',minimum:1}}] ].map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}})),
 {name:'playlist_list',description:'Read saved YouTube playlists and long mixes, including their exact original URLs. Not playback history.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'playlist_save',description:'Owner-requested: save a YouTube playlist or long-mix video URL in Music. No playback, download, account playlist or import. Duplicate resources retain the first exact URL and metadata.',inputSchema:{type:'object',properties:{url:{type:'string',maxLength:2048},title:{type:'string',maxLength:2000},author:{type:'string',maxLength:300},authorUrl:{type:'string',maxLength:2048},thumbnail:{type:'string',maxLength:2048}},required:['url'],additionalProperties:false}},
 {name:'music_status', description:'Read app configuration status; does not prove upstream connectivity.', inputSchema:{type:'object', properties:{}, additionalProperties:false}},
 {name:'music_home', description:'Read sources, library, liked tracks and recent history.', inputSchema:{type:'object', properties:{}, additionalProperties:false}},
 {name:'music_search', description:'Search configured library and optionally enabled online catalog.', inputSchema:{type:'object', properties:{query:{type:'string',maxLength:200}}, required:['query'], additionalProperties:false}}
]
export async function handleMcp(req,res,send,port) {
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
 if(m.method==='tools/list'){answer({tools});return}
 if(m.method!=='tools/call'){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});return}
 const name=m.params?.name, a=m.params?.arguments||{}
 if(name==='playlist_list'||name==='playlist_save'){
  const write=name==='playlist_save'
  const allowed=['url','title','author','authorUrl','thumbnail']
  if(!a||Array.isArray(a)||typeof a!=='object'||Object.keys(a).some(k=>!allowed.includes(k))||(!write&&Object.keys(a).length)||(write&&(typeof a.url!=='string'||Object.values(a).some(v=>typeof v!=='string')))){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid playlist arguments'}});return}
  try{const r=await fetch(`http://127.0.0.1:${port}/wizard-music/api/playlists`,{...(write?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a)}:{}),signal:AbortSignal.timeout(150000)});answer({content:[{type:'text',text:await r.text()}],isError:!r.ok})}catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
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
 if(!Object.hasOwn(paths,name) || (name==='music_search' && typeof a.query!=='string')){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid tool or arguments'}});return}
 try {const r=await fetch(`http://127.0.0.1:${port}${paths[name]}`,{signal:AbortSignal.timeout(150000)}); answer({content:[{type:'text',text:await r.text()}],isError:!r.ok})}catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
}
