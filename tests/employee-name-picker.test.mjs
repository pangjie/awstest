import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {exportLoader} from "./helpers/load-export-typescript.mjs";

const code=ts.transpileModule(fs.readFileSync("app/timekeeping/employee-name-picker.tsx","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const context={exports:{},require:()=>({})};vm.runInNewContext(code,context);
const {matchEmployeeNames}=context.exports;
test("name matching ignores case and accents, keeps duplicates deterministic and does not search IDs",()=>{
  const employees=[{id:3,name:"José Garcia",badgeCode:"ABC123",organization:"OZM"},{id:2,name:"Ana Maria",badgeCode:"DEF456",organization:"JJC"},{id:1,name:"Ana Maria",badgeCode:"XYZ987",organization:"OZM"}];
  const ids=query=>Array.from(matchEmployeeNames(employees,query),employee=>employee.id);
  assert.deepEqual(ids(" JOSE "),[3]);assert.deepEqual(ids("gar"),[3]);
  assert.deepEqual(ids("MAR"),[1,2]);assert.deepEqual(ids(""),[]);
  assert.deepEqual(ids("ABC123"),[]);assert.deepEqual(ids("OZM"),[]);
  assert.deepEqual(employees.map(employee=>employee.id),[3,2,1]);
});

test("name lookup uses task-dispatch permission and selects only active employee lookup fields",async()=>{
  let authorized=false,queries=0;
  const load=exportLoader({
    "../../../../../lib/internal-auth":{authorizePageAccess:async page=>{assert.equal(page,"time-scan");return authorized?{authorized:true}:{authorized:false,status:403,message:"denied"}}},
    "../../../../../lib/timekeeping/scan":{},"../../../../../lib/timekeeping/read-model":{},"../../../../../lib/timekeeping/data":{},
    "../../../../../db/timekeeping-runtime":{ensureTimekeepingSchema:async()=>{}},
    "../../../../../db":{getPool:()=>({query:async sql=>{queries++;assert.match(sql,/WHERE active=true/);assert.match(sql,/COALESCE\(employee_code,badge_code\)/);assert.doesNotMatch(sql,/SELECT \*/);return {rows:[{id:1,name:"Ana",organization:"OZM",badgeCode:"TEST"}]}}})},
  });
  const route=load("app/api/v1/timekeeping/scan/route.ts");
  const request={nextUrl:new URL("http://localhost/api/v1/timekeeping/scan?lookup=employees")};
  assert.equal((await route.GET(request)).status,403);assert.equal(queries,0);
  authorized=true;const response=await route.GET(request);
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal((await response.json()).employees[0].name,"Ana");assert.equal(queries,1);
});

test("unified input auto-scans exact codes, requires Enter for names and ignores composition Enter",()=>{
  function input(query,composing=false){
    const selected=[],scanned=[],timers=[];let index=0;
    const states=[composing,true,[{id:1,name:"Mary",badgeCode:"CFHK3467",legacyBadgeCode:"CFHK",organization:"OZM"}],false,""];
    const runtime={exports:{},AbortController,window:{setTimeout:fn=>{timers.push(fn);return 1},clearTimeout:()=>{}},require:name=>{
      if(name==="react")return {useState:()=>[states[index++],()=>{}],useRef:value=>({current:value}),useEffect:fn=>fn()};
      if(name==="react/jsx-runtime")return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
      if(name==="@/app/ui-language")return {useLanguage:()=>{},t:value=>value};
      return {timeApi:()=>new Promise(()=>{})};
    }};
    vm.runInNewContext(code,runtime);
    const tree=runtime.exports.EmployeeNamePicker({query,setQuery:()=>{},inputRef:{current:null},disabled:false,isTaskCode:value=>value==="JOB-CLEAN",onSelect:value=>selected.push(value),onCode:value=>scanned.push(value)});
    return {selected,scanned,timers,enter:()=>tree.props.children[0].props.onKeyDown({key:"Enter",nativeEvent:{isComposing:composing},preventDefault(){}})};
  }
  for(const query of ["CFHK3467","CFHK","JOB-CLEAN"]){const app=input(query);assert.equal(app.timers.length,1);app.enter();app.timers.forEach(fn=>fn());assert.deepEqual(app.scanned,[query]);assert.deepEqual(app.selected,[])}
  const name=input("Mar");assert.equal(name.timers.length,0);assert.deepEqual(name.selected,[]);name.enter();assert.deepEqual(name.selected,["CFHK3467"]);
  const unknown=input("Missing");unknown.enter();assert.deepEqual(unknown.scanned,[]);assert.deepEqual(unknown.selected,[]);
  const composing=input("Mar",true);composing.enter();assert.deepEqual(composing.selected,[]);
});

test("first lookup survives Strict Mode cleanup and displays the existing query without refocusing",async()=>{
  const states=[],refs=[],effects=[],requests=[];
  let stateIndex=0,refIndex=0;
  const runtime={exports:{},AbortController,require:name=>{
    if(name==="react")return {
      useState:initial=>{const i=stateIndex++;if(!(i in states))states[i]=initial;return[states[i],value=>{states[i]=typeof value==="function"?value(states[i]):value}]},
      useRef:initial=>{const i=refIndex++;return refs[i]??=( {current:initial})},
      useEffect:fn=>effects.push(fn),
    };
    if(name==="react/jsx-runtime")return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==="@/app/ui-language")return {useLanguage(){},t:value=>value};
    return {timeApi:()=>new Promise(resolve=>requests.push({resolve}))};
  }};
  vm.runInNewContext(code,runtime);
  let query="";
  const render=()=>{stateIndex=0;refIndex=0;return runtime.exports.EmployeeNamePicker({query,setQuery:value=>{query=value},inputRef:{current:null},disabled:false,isTaskCode:()=>false,onSelect(){},onCode(){}})};
  let tree=render();
  const cleanup=effects[0]();
  tree.props.children[0].props.onFocus();
  cleanup();const cleanupRestart=effects[0]();
  tree.props.children[0].props.onChange({target:{value:"t"}});
  requests[1].resolve({employees:[{id:1,name:"tester",badgeCode:"CFHK3467",organization:"OZM"}]});
  await new Promise(resolve=>setImmediate(resolve));
  requests[0].resolve({employees:[{id:99,name:"stale"}]});
  await new Promise(resolve=>setImmediate(resolve));
  tree=render();
  const options=tree.props.children[1].props.children;
  assert.equal(options.length,1);assert.equal(options[0].props.children[0].props.children,"tester");
  assert.equal(states[3],false);
  tree.props.children[0].props.onFocus();
  assert.equal(requests.length,2);assert.equal(states[3],false);
  cleanupRestart();
});
