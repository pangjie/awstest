import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile,readdir } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as language from "../lib/ui-language.ts";

const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");
const source=await read("app/ui-language.tsx");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

function client({stored,blockedStorage=false}={}){
  const effects=[],writes=[],subscriptions=[],events=new Map();
  const context={exports:{},document:{documentElement:{lang:"zh-CN"},querySelectorAll:()=>[]},
    localStorage:{getItem:()=>{if(blockedStorage)throw new Error("blocked");return stored},setItem:(key,value)=>{if(blockedStorage)throw new Error("blocked");writes.push({key,value})}},
    window:{addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)},
    require(name){
      if(name==="react")return {useEffect:fn=>effects.push(fn),useSyncExternalStore:(subscribe,snapshot)=>{subscriptions.push(subscribe(()=>{}));return snapshot()}};
      if(name==="react/jsx-runtime")return {jsx:(tag,props)=>({tag,props}),jsxs:(tag,props)=>({tag,props})};
      if(name==="@/lib/ui-language")return language;
      if(name==="./ui-language.css")return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
    fetch(){throw new Error("Language switching must not make requests")},
  };
  vm.runInNewContext(compiled,context);
  return {api:context.exports,context,effects,writes,events,render:()=>context.exports.default()};
}

test("all dictionaries are complete, preserve parameters, and reject unknown language preferences",()=>{
  assert.ok(Object.keys(language.messages).length>500);
  for(const [key,translations] of Object.entries(language.messages)){
    assert.equal(translations.length,2,key);
    const parameters=text=>[...text.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort();
    for(const text of translations){assert.ok(text.trim(),key);assert.deepEqual(parameters(text),parameters(key),key)}
  }
  for(const value of [null,undefined,"fr","es-MX","__proto__",{}])assert.equal(language.isLanguage(value),false);
});

test("unknown text and interpolated business data stay unchanged",()=>{
  for(const value of ["张三","SKU-ABC","W202608270001","A-A-001","这是一条用户备注"]){
    for(const locale of language.LANGUAGES)assert.equal(language.translate(locale,value),value);
  }
  assert.equal(language.translate("es","波次 {0}",{0:"W-{1}-<script>"}),"Ola W-{1}-<script>");
  assert.equal(language.translate("zh","{0}小时 {1}分",{0:125,1:"09"}),"125小时 09分");
  assert.equal(language.translate("es","{0}小时 {1}分",{0:125,1:"09"}),"125h 09m");
});

test("one button cycles all languages locally and keeps translator identity stable",()=>{
  const app=client(),translate=app.api.t;
  assert.equal(app.api.t("保存"),"保存");
  for(const [locale,label] of [["en","Save"],["es","Guardar"],["zh","保存"]]){
    app.render().props.onClick();
    assert.equal(app.api.useLanguage().language,locale);
    assert.equal(app.api.t,translate);
    assert.equal(app.api.t("保存"),label);
  }
  assert.deepEqual(app.writes.map(item=>item.value),["en","es","zh"]);
  assert.ok(app.writes.every(item=>item.key===language.LANGUAGE_STORAGE_KEY));
});

test("saved preference loads after mount; restricted storage does not block switching",()=>{
  const app=client({stored:"es"});app.render();
  assert.equal(app.api.useLanguage().language,"zh");
  app.effects[0]();
  assert.equal(app.api.useLanguage().language,"es");
  assert.equal(app.context.document.documentElement.lang,"es");
  assert.equal(app.events.size,0);
  const restricted=client({blockedStorage:true});restricted.render();restricted.effects[0]();
  restricted.render().props.onClick();assert.equal(restricted.api.useLanguage().language,"en");
});

test("task names are translated only for known tasks and durations do not change their values",()=>{
  const app=client();app.render().props.onClick();
  assert.equal(app.api.taskText("仓务","WAREHOUSE"),"Warehouse");
  assert.equal(app.api.taskText("仓务","CUSTOM-TASK"),"仓务");
  assert.equal(app.api.taskText("波次 W000123 · 已暂停"),"Wave W000123 · Paused");
  assert.equal(app.api.durationText("125小时 09分"),"125h 09m");
  assert.equal(app.api.durationText("125:09:01"),"125:09:01");
});

test("every literal UI translation key exists in all three languages",async()=>{
  const files=["app/login-form.tsx","app/warehouse-app.tsx","app/mobile-warehouse-tasks.tsx","app/employee-status/status-board.tsx",...(await readdir(new URL("../app/timekeeping",import.meta.url))).filter(name=>name.endsWith(".tsx")).map(name=>`app/timekeeping/${name}`)];
  for(const file of files){
    const ast=ts.createSourceFile(file,await read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node){
      if(ts.isCallExpression(node)&&node.expression.getText(ast)==="t"&&ts.isStringLiteral(node.arguments[0])){
        assert.ok(Object.hasOwn(language.messages,node.arguments[0].text),`${file}: ${node.arguments[0].text}`);
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
});

test("language helpers do not perform network requests, navigation, or database writes",async()=>{
  assert.doesNotMatch(source,/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|router\.|location\.(reload|replace)|document\.cookie|import\(/);
  assert.match(source,/useSyncExternalStore/);
  const dashboard=await read("app/timekeeping/dashboard-page.tsx");
  assert.match(dashboard,/label==="员工"\|\|label==="渠道"\?option.label:t\(option.label\)/);
  const records=await read("app/timekeeping/records-page.tsx");
  const printed=records.split("function MonthlyPrintReport(")[1].split("function indexAttendancePairs(")[0];
  assert.doesNotMatch(printed,/\bt\(|useLanguage|durationText/);
  const board=await read("app/employee-status/status-board.tsx");
  assert.match(board,/EMPLOYEE_STATUS_LABELS\[employee.state\].split\(" \/ "\)\[0\]/);
});

test("language restore never freezes pre-translation dimensions and dashboard can grow",async()=>{
  assert.doesNotMatch(source,/getBoundingClientRect|lockLabelSizes|--ui-label-width/);
  const css=await read("app/ui-language.css");
  assert.doesNotMatch(css,/data-ui-locked|--ui-label-height/);
  const layout=await read("app/timekeeping.css");
  assert.match(layout,/\.workspace > header \{ height: auto; min-height: 84px;[^}]*flex-wrap: wrap/);
  assert.match(layout,/\.time-dashboard-wave-title \{ flex-wrap: wrap/);
  assert.match(layout,/html:not\(\[lang="zh-CN"\]\) \.time-dashboard-wave-table \{ table-layout: auto/);
});
