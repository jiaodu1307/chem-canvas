import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMcpServer} from '../server/mcp.js';
import {ensureCanvas} from '../server/plugin-runtime.js';
import {projectEndpoint, selectProject, validateProjectId} from '../server/project-binding.js';
import {toolsForProfile} from '../server/tool-profile.js';

const defaultPort=4327;
const usage='node scripts/plugin-http.js --project PROJECT_ID [--profile full|figure|figure-chemistry] [--port 4327] [--url http://127.0.0.1:4317]';

// The SDK owns JSON-RPC and transport negotiation. This listener exposes just one project.
export async function startMcpHttp({canvasUrl,projectId,port=defaultPort,profile='full'}) {
  validateProjectId(projectId);
  toolsForProfile(profile);
  if(!Number.isInteger(port) || port<0 || port>65535)throw Error('Port must be between 0 and 65535.');
  const backend=projectEndpoint(canvasUrl,projectId).url.origin;
  const response=await fetch(backend+'/api/projects',{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('Cannot read the project catalog.');
  const {projects}=await response.json();
  if(!Array.isArray(projects))throw Error('Invalid project catalog.');
  selectProject({boundProjectId:projectId,projects});

  const listener=http.createServer(async(request,response)=>{
    const host=request.headers.host;
    const localPort=request.socket.localPort;
    const localHost=host==='127.0.0.1:'+localPort || host==='localhost:'+localPort
      || (localPort===80 && (host==='127.0.0.1' || host==='localhost'));
    if(!localHost || (request.headers.origin!==undefined && request.headers.origin!=='http://'+host)
      || request.headers['sec-fetch-site']==='cross-site'){
      response.writeHead(403).end();return;
    }
    if(request.url!=='/mcp'){response.writeHead(404).end();return;}
    // This stateless server returns responses on POST and offers no separate event stream.
    if(request.method!=='POST'){response.writeHead(405,{Allow:'POST'}).end();return;}
    const mcp=createMcpServer(backend,{projectId,toolProfile:profile});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:8*1024*1024});
    response.once('close',()=>mcp.close().catch(()=>{}));
    try{
      await mcp.connect(transport);
      await transport.handleRequest(request,response);
    }catch{
      if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32603,message:'MCP request failed.'}}));
      else response.destroy();
    }
  });
  await new Promise((resolve,reject)=>{
    listener.once('error',reject);
    listener.listen(port,'127.0.0.1',()=>{listener.off('error',reject);resolve();});
  });
  return {url:'http://127.0.0.1:'+listener.address().port+'/mcp',close:()=>new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()))};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{help:{type:'boolean',short:'h'},project:{type:'string'},profile:{type:'string'},url:{type:'string'},port:{type:'string'}}});
    if(values.help)console.log(usage);
    else{
      const projectId=validateProjectId(values.project);
      const profile=values.profile ?? process.env.CHEM_CANVAS_TOOL_PROFILE ?? 'full';
      toolsForProfile(profile);
      if(values.port!==undefined && (!/^\d+$/.test(values.port) || Number(values.port)>65535))throw Error('Invalid HTTP listener port.');
      const env={...process.env,CHEM_CANVAS_PROJECT_ID:projectId};
      if(values.url!==undefined)env.CHEM_CANVAS_URL=values.url;
      const runtime=await ensureCanvas({env});
      const bridge=await startMcpHttp({canvasUrl:runtime.url,projectId,profile,port:Number(values.port ?? defaultPort)});
      console.log('Chem Canvas MCP ('+projectId+', '+profile+'): '+bridge.url);
      const stop=()=>bridge.close().catch(error=>{console.error(error.message);process.exitCode=1;});
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
    }
  }catch(error){console.error(error.message+'\n'+usage);process.exitCode=1;}
}
