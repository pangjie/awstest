import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as model from "../lib/employee-status.ts";

const source=await readFile(new URL("../app/employee-status/status-board.tsx",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const fetchSource=await readFile(new URL("../lib/client-fetch.ts",import.meta.url),"utf8");
const compiledFetch=ts.transpileModule(fetchSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;

// Execute the actual polling effect with a virtual clock, without a browser or database.
async function board(start,employees=[],useFetchWrapper=false){
  let now=Date.parse(start),effect,timerId=0,respond;
  let fetchWithTimeout;
  const timers=new Map(),requests=[],listeners={},updates=[],states=[];
  const document={visibilityState:"visible",addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener:name=>delete listeners[name]};
  const response=(status=304,items=employees)=>({status,ok:status>=200&&status<300,json:async()=>({revision:1,date:model.statusClock(now).date,generatedAt:new Date(now).toISOString(),employees:items})});
  respond=async url=>response(url.includes("/revision")?304:200);
  const context={exports:{},AbortController,Date:class extends Date{static now(){return now}},document,
    window:{setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:now+ms});return id},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval:()=>{}},
    require:name=>{
      if(name==="react")return {useState:value=>{const index=states.length;states.push(value);return [value,next=>{states[index]=next;updates.push(next)}]},useEffect:fn=>effect=fn};
      if(name==="react/jsx-runtime")return {jsx:()=>null,jsxs:()=>null};
      if(name==="@/lib/employee-status")return model;
      if(name==="@/app/ui-language")return {useLanguage:()=>({language:"zh"}),t:(source,values={})=>source.replace(/\{(\d+)\}/g,(token,key)=>key in values?String(values[key]):token)};
      if(name==="@/lib/client-fetch")return {fetchWithTimeout};
      throw new Error(name);
    }};
  const fetch=async(url,options)=>{requests.push({url,at:now,options});return respond(url,options)};
  const fetchContext={exports:{},AbortController,window:context.window,fetch};
  vm.runInNewContext(compiledFetch,fetchContext);
  fetchWithTimeout=useFetchWrapper?fetchContext.exports.fetchWithTimeout:fetch;
  vm.runInNewContext(compiled,context);context.exports.default();const cleanup=effect();
  const settle=async()=>{for(let n=0;n<20;n++)await Promise.resolve()};
  await settle();
  return {requests,updates,response,cleanup,get changes(){return states[6]},setRespond:fn=>respond=fn,
    async advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn()}await settle()},
    async visible(value){document.visibilityState=value?"visible":"hidden";listeners.visibilitychange();await settle()},
  };
}

test("status polling reads once outside hours and resumes at 07:00 without reload",async()=>{
  const app=await board("2026-09-29T10:59:58Z");
  try{
    assert.equal(app.requests.length,1);await app.advance(1000);assert.equal(app.requests.length,1);
    await app.advance(1000);assert.equal(app.requests.length,2);
    assert.ok(app.requests[1].url.endsWith("employee-status"));
    await app.advance(1000);assert.equal(app.requests.length,3);assert.ok(app.requests[2].url.endsWith("revision?scope=employee-status"));
    assert.equal(app.requests[2].options.headers["if-none-match"],'"1"');
  }finally{app.cleanup()}
});

test("completed requests are not aborted when the board unmounts",async()=>{
  const app=await board("2026-09-29T15:00:00Z");
  app.cleanup();
  assert.equal(app.requests[0].options.signal.aborted,false);
});

for(const useFetchWrapper of [false,true])test(`in-flight cancellation is quiet and visibility resumes (fetch wrapper: ${useFetchWrapper})`,async()=>{
  const app=await board("2026-09-29T15:00:00Z",[],useFetchWrapper);
  try{
    app.setRespond((_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    }));
    await app.advance(1000);
    await app.visible(false);
    assert.equal(app.requests.at(-1).options.signal.aborted,true);
    assert.ok(!app.updates.includes("连接异常，数据可能已过期"));
    await app.advance(5000);
    assert.equal(app.requests.length,2);
    app.setRespond(async()=>app.response(200));
    await app.visible(true);
    assert.ok(app.requests.at(-1).url.endsWith("employee-status"));
    app.setRespond((_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    }));
    await app.advance(1000);
    app.cleanup();
    const updateCount=app.updates.length,requestCount=app.requests.length;
    await app.advance(30000);
    assert.equal(app.updates.length,updateCount);
    assert.equal(app.requests.length,requestCount);
  }finally{app.cleanup()}
});

test("a late revision response cannot start a snapshot request after cleanup",async()=>{
  const app=await board("2026-09-29T15:00:00Z");
  let resolve;
  app.setRespond(()=>new Promise(done=>resolve=done));
  await app.advance(1000);
  app.cleanup();
  const updateCount=app.updates.length;
  resolve(app.response(200));
  await app.advance(30000);
  assert.equal(app.requests.length,2);
  assert.equal(app.updates.length,updateCount);
});

test("real fetch timeout remains a connection error and triggers retry",async()=>{
  const app=await board("2026-09-29T15:00:00Z",[],true);
  try{
    app.setRespond((_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    }));
    await app.advance(1000);
    await app.advance(15000);
    assert.ok(app.updates.includes("连接异常，数据可能已过期"));
    app.setRespond(async()=>app.response(200));
    await app.advance(2000);
    assert.ok(app.requests.at(-1).url.endsWith("employee-status"));
  }finally{app.cleanup()}
});

test("card highlights only state or task changes, restarts per employee and suppresses recovery",async()=>{
  const employee={id:1,name:"张三",state:"ready",task:null};
  const app=await board("2026-09-29T15:00:00Z",[employee]);
  try{
    assert.equal(Object.keys(app.changes).length,0);
    const update=async items=>{app.setRespond(async()=>app.response(200,items));await app.advance(1000)};
    await update([{...employee,name:"张三改名"}]);assert.equal(Object.keys(app.changes).length,0);
    await update([{...employee,state:"picking",task:"波次 A"}]);
    const first=app.changes[1];assert.ok(first.sequence>0);assert.equal(first.kind,"flip");
    await update([{...employee,state:"picking",task:"波次 A"}]);assert.equal(app.changes[1],first);
    await update([{...employee,state:"picking",task:"波次 B"}]);assert.ok(app.changes[1].sequence>first.sequence);assert.equal(app.changes[1].kind,"sheen");
    app.setRespond(async()=>{throw new Error("offline")});await app.advance(1000);
    app.setRespond(async()=>app.response(200,[{...employee,state:"off"}]));await app.advance(2000);
    assert.equal(Object.keys(app.changes).length,0);
    await app.visible(false);
    app.setRespond(async()=>app.response(200,[employee]));await app.visible(true);
    assert.equal(Object.keys(app.changes).length,0);
    await update([employee,{...employee,id:2}]);assert.equal(Object.keys(app.changes).length,0);
  }finally{app.cleanup()}
});

test("the next poll starts a new flip after the 750ms animation has finished",async()=>{
  const employee={id:1,name:"张三",state:"ready",task:null};
  const app=await board("2026-09-29T15:00:00Z",[employee]);
  try{
    app.setRespond(async()=>app.response(200,[{...employee,state:"picking",task:"波次 A"}]));await app.advance(1000);
    const flip=app.changes[1];
    app.setRespond(async()=>app.response(200,[{...employee,state:"off",task:"波次 A · 已暂停"}]));await app.advance(1000);
    assert.ok(app.changes[1].sequence>flip.sequence);
    assert.equal(app.changes[1].previous.state,"picking");
    const latest=app.updates.filter(value=>value?.employees).at(-1);
    assert.equal(latest.employees[0].state,"off");
  }finally{app.cleanup()}
});

test("card rotation takes 750ms with no intermediate easing stops",async()=>{
  const css=await readFile(new URL("../app/employee-status/status-board.css",import.meta.url),"utf8");
  assert.match(css,/employee-card-turn \.75s cubic-bezier/);
  assert.match(css,/employee-card-lift \.75s/);
  const turn=css.split("@keyframes employee-card-turn {")[1].split("\n}")[0];
  assert.equal((turn.match(/rotateY\(/g)||[]).length,2);
  assert.match(turn,/0% \{ transform: rotateY\(0deg\)/);
  assert.match(turn,/100% \{ transform: rotateY\(180deg\)/);
});

test("switching from warehouse to picking is task-only because both display working",async()=>{
  const employee={id:1,name:"张三",state:"warehouse",task:"仓务"};
  const app=await board("2026-09-29T15:00:00Z",[employee]);
  try{
    app.setRespond(async()=>app.response(200,[{...employee,state:"picking",task:"波次 A"}]));await app.advance(1000);
    assert.equal(app.changes[1].kind,"sheen");
  }finally{app.cleanup()}
});

test("status polling stops at 22:00 and while hidden",async()=>{
  const app=await board("2026-09-30T01:59:57Z");
  try{
    await app.visible(false);await app.advance(1000);assert.equal(app.requests.length,1);
    await app.visible(true);assert.equal(app.requests.length,2);
    await app.advance(2000);assert.equal(app.requests.length,2);
    await app.visible(true);assert.equal(app.requests.length,2);
  }finally{app.cleanup()}
});

test("status polling is serial, retries failed snapshots and stops on lost permission",async()=>{
  const app=await board("2026-09-29T15:00:00Z");
  try{
    let resolve;
    app.setRespond(()=>new Promise(done=>resolve=done));
    await app.advance(1000);assert.equal(app.requests.length,2);
    await app.advance(5000);await app.visible(true);assert.equal(app.requests.length,2);
    app.setRespond(async()=>{throw new Error("offline")});
    resolve(app.response(200));await app.advance(0);assert.equal(app.requests.length,3);
    await app.advance(1000);assert.equal(app.requests.length,3);
    app.setRespond(async()=>app.response(403));
    await app.advance(1000);assert.equal(app.requests.length,4);
    await app.advance(30000);assert.equal(app.requests.length,4);
    assert.ok(app.updates.includes(null));
  }finally{app.cleanup()}
});
