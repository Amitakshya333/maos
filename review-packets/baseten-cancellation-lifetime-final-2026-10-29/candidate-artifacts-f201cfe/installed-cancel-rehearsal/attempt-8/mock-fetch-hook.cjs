'use strict';
const fs=require('node:fs');
const path=require('node:path');
const nativeFetch=globalThis.fetch;
const stateDir=process.env.MAOS_TEST_STATE_DIR;
const port=Number(process.env.MAOS_TEST_MOCK_PORT);
function append(name,obj){try{fs.appendFileSync(path.join(stateDir,name),JSON.stringify(obj)+'\n');}catch{}}
append('hook-loads.jsonl',{pid:process.pid,parentPid:process.ppid,exe:path.basename(process.execPath),electron:process.versions.electron||null,processType:process.type||null,at:new Date().toISOString()});
if(typeof nativeFetch!=='function'||!stateDir||!Number.isInteger(port)||port<1)throw new Error('The isolated loopback mock hook is not configured.');
function getUrl(input){return input instanceof Request?new URL(input.url):new URL(input instanceof URL?input.href:String(input));}
function loopback(url){return url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);}
globalThis.fetch=async function(input,init={}){
  const url=getUrl(input);
  if(url.origin==='https://inference.baseten.co'){
    if(url.pathname!=='/v1/chat/completions')throw new Error('The pilot mock blocks unsupported Baseten paths.');
    const request=input instanceof Request?input:null;
    const headers=new Headers(request?.headers||undefined);
    if(init.headers)for(const [k,v] of new Headers(init.headers))headers.set(k,v);
    const hadAuthorization=headers.has('authorization');
    headers.delete('authorization');
    headers.set('x-maos-test-authorization-present',hadAuthorization?'true':'false');
    const body=init.body!==undefined?init.body:(request?request.body:undefined);
    const options={...init,method:init.method||(request&&request.method)||'GET',headers,body,signal:init.signal||(request&&request.signal),redirect:'error'};
    if(body&&typeof body.getReader==='function'&&!options.duplex)options.duplex='half';
    append('provider-intercepts.jsonl',{pid:process.pid,host:url.hostname,path:url.pathname,authorizationConfigured:hadAuthorization,authorizationForwarded:false,at:new Date().toISOString()});
    return nativeFetch('http://127.0.0.1:'+port+url.pathname+url.search,options);
  }
  if(loopback(url))return nativeFetch(input,init);
  append('blocked-nonloopback.jsonl',{pid:process.pid,origin:url.origin,at:new Date().toISOString()});
  throw new Error('The installed-pilot rehearsal blocks non-loopback network requests.');
};
