import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { statusClock,employeeStatus,sortStatusEmployees,EMPLOYEE_STATUS_LABELS,employeeTaskStyle } from "../lib/employee-status.ts";
import { effectivePagePermissions,canAccessAnyPage } from "../lib/page-permissions.ts";

test("employee board uses New York 07:00 inclusive to 22:00 exclusive in summer and winter",()=>{
  for(const [date,active] of [
    ["2026-09-29T10:59:59Z",false],["2026-09-29T11:00:00Z",true],
    ["2026-09-30T01:59:59Z",true],["2026-09-30T02:00:00Z",false],
    ["2026-01-05T11:59:59Z",false],["2026-01-05T12:00:00Z",true],
    ["2026-01-06T03:00:00Z",false],
  ])assert.equal(statusClock(Date.parse(date)).active,active,date);
  assert.equal(statusClock(Date.parse("2026-09-30T02:00:00Z")).date,"2026-09-29");
});

test("employee card state respects attendance, paused tasks and scanning classification",()=>{
  assert.equal(employeeStatus(false,false,false,null,null),"not_started");
  assert.equal(employeeStatus(false,true,true,"standard","JOB-WAREHOUSE"),"off");
  assert.equal(employeeStatus(true,true,false,"wave","W1"),"ready");
  assert.equal(employeeStatus(true,true,true,"wave","W1"),"picking");
  for(const code of ["JOB-SCAN","JOB-SINGLE-SCAN"])assert.equal(employeeStatus(true,true,true,"standard",code),"picking");
  assert.equal(employeeStatus(true,true,true,"standard","JOB-CLEAN"),"warehouse");
});

test("employee cards show four bilingual labels without changing task classification",()=>{
  assert.equal(EMPLOYEE_STATUS_LABELS.picking,"在岗 / Trabajando");
  assert.equal(EMPLOYEE_STATUS_LABELS.warehouse,EMPLOYEE_STATUS_LABELS.picking);
  assert.equal(EMPLOYEE_STATUS_LABELS.ready,"待命 / En espera");
  assert.equal(EMPLOYEE_STATUS_LABELS.off,"休息 / Descanso");
  assert.equal(EMPLOYEE_STATUS_LABELS.not_started,"未上班 / Sin iniciar");
  assert.equal(new Set(Object.values(EMPLOYEE_STATUS_LABELS)).size,4);
});

test("employee card order is stable across state changes and duplicate names",()=>{
  const people=[{id:2,name:"张三",state:"off",task:null},{id:3,name:"李四",state:"ready",task:null},{id:1,name:"张三",state:"picking",task:null}];
  const first=sortStatusEmployees(people.map(p=>({...p}))).map(p=>p.id);
  const second=sortStatusEmployees(people.map(p=>({...p,state:"warehouse"}))).map(p=>p.id);
  assert.deepEqual(first,[3,1,2]);assert.deepEqual(second,first);
});

test("badge artwork distinguishes task types and keeps paused tasks recognizable",()=>{
  for(const [task,kind] of [["仓务","warehouse"],["波次 W123","wave"],["混件扫描","scan"],["单件扫描","scan"],["问题单","issue"],["清洁","clean"],["新增任务","other"]]){
    assert.equal(employeeTaskStyle({id:1,name:"员工",state:"warehouse",task}),kind);
    assert.equal(employeeTaskStyle({id:1,name:"员工",state:"off",task:task+" · 已暂停"}),kind);
  }
  assert.equal(employeeTaskStyle({id:1,name:"员工",state:"ready",task:null}),"idle");
});

test("employee status is separately granted and the endpoint is read only",async()=>{
  assert.ok(effectivePagePermissions("admin",[]).includes("time-status"));
  assert.equal(canAccessAnyPage({role:"user",pagePermissions:["time-employees"]},["time-status"]),false);
  assert.equal(canAccessAnyPage({role:"user",pagePermissions:["time-status"]},["time-status"]),true);
  const api=await readFile(new URL("../app/api/v1/timekeeping/employee-status/route.ts",import.meta.url),"utf8");
  assert.match(api,/authorizePageAccess\("time-status"\)/);
  assert.match(api,/WHERE e.active=true/);
  assert.doesNotMatch(api,/export async function (POST|PUT|PATCH|DELETE)|reconcileStaleOpenShifts|badge_code|employee_code/);
  const revision=await readFile(new URL("../app/api/v1/timekeeping/revision/route.ts",import.meta.url),"utf8");
  assert.match(revision,/get\("scope"\)==="employee-status"\s*\?await authorizePageAccess\("time-status"\)/);
});
