'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const stateDir = process.argv[2];
fs.mkdirSync(stateDir,{recursive:true});
function save(name,value){const p=path.join(stateDir,name);const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(value,null,2));fs.renameSync(t,p);}
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&u.pathname==='/_health'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true}));return;}
  if(req.method==='GET'&&u.pathname==='/_status'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ready:true,requests:fs.existsSync(path.join(stateDir,'request-active.json'))?1:0}));return;}
  if(req.method==='GET'&&u.pathname==='/_shutdown'){
    res.writeHead(200,{'content-type':'text/plain'}).end('stopping');
    setImmediate(()=>{server.closeAllConnections?.();server.close(()=>process.exit(0));});
    return;
  }
  if(req.method!=='POST'||u.pathname!=='/v1/chat/completions'){save('unexpected-loopback-request.json',{method:req.method,path:u.pathname});res.writeHead(404).end();return;}
  const chunks=[];let n=0;
  req.on('data',c=>{n+=c.length;if(n<=1024*1024)chunks.push(c);});
  req.on('end',()=>{
    let body={};try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    const record={requestCount:1,method:req.method,path:u.pathname,model:typeof body.model==='string'?body.model:null,toolNames:Array.isArray(body.tools)?body.tools.map(t=>t?.function?.name).filter(x=>typeof x==='string'):[],authorizationHeaderPresentAtLoopback:Object.hasOwn(req.headers,'authorization'),authorizationWasConfiguredAtClient:req.headers['x-maos-test-authorization-present']==='true',contentLength:n,receivedAt:new Date().toISOString(),connectionClosed:false,requestAborted:false};
    save('request-active.json',record);
    req.on('aborted',()=>{record.requestAborted=true;record.connectionClosed=true;record.closedAt=new Date().toISOString();save('request-active.json',record);});
    res.on('close',()=>{if(!res.writableEnded){record.connectionClosed=true;record.closedAt=new Date().toISOString();save('request-active.json',record);}});
    const timer=setTimeout(()=>{if(!res.writableEnded){record.failSafeResponse=true;save('request-active.json',record);res.writeHead(504,{'content-type':'application/json'}).end('{"error":"test mock hold timed out"}');}},120000);
    timer.unref();
  });
});
server.listen(0,'127.0.0.1',()=>{
  const addr=server.address();
  save('mock-server-ready.json',{pid:process.pid,host:'127.0.0.1',port:addr.port,startedAt:new Date().toISOString()});
});
