const tools = [
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
 const paths={music_status:'/wizard-music/api/status',music_home:'/wizard-music/api/home',music_search:'/wizard-music/api/search?q='+encodeURIComponent(typeof a.query==='string'?a.query.slice(0,200):'')}
 if(!Object.hasOwn(paths,name) || (name==='music_search' && typeof a.query!=='string')){send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid tool or arguments'}});return}
 try {const r=await fetch(`http://127.0.0.1:${port}${paths[name]}`,{signal:AbortSignal.timeout(150000)}); answer({content:[{type:'text',text:await r.text()}],isError:!r.ok})}catch{answer({content:[{type:'text',text:'Music backend unavailable'}],isError:true})}
}
