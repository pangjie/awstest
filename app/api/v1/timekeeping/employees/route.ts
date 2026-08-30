import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { ensureTimekeepingSchema } from "../../../../../db/timekeeping-runtime";
import { timeEmployees,timeShifts } from "../../../../../db/timekeeping-schema";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { lockTimekeeping, recordTimeRevision } from "../../../../../lib/timekeeping/data";
import { generateEmployeeId, LEGACY_EMPLOYEE_ID_LENGTH } from "../../../../../lib/timekeeping/employee-id";
import { readEmployees } from "../../../../../lib/timekeeping/read-model";
import { performScan } from "../../../../../lib/timekeeping/scan";

export const dynamic="force-dynamic";

export async function GET(){
  const access=await authorizePageAccess("time-employees");
  if(!access.authorized)return denied(access);
  await ensureTimekeepingSchema();
  return NextResponse.json(await readEmployees(),{headers:{"cache-control":"no-store"}});
}

export async function POST(request:NextRequest){
  const access=await authorizePageAccess("time-employees");
  if(!access.authorized)return denied(access);
  await ensureTimekeepingSchema();
  const payload=await request.json().catch(()=>({})) as EmployeeInput&{items?:EmployeeInput[]};
  const rawItems=Array.isArray(payload.items)?payload.items:[payload];
  if(!rawItems.length||rawItems.length>250)return error("每次可新增 1–250 名员工",400);
  const items=rawItems.map(normalizeEmployee);
  if(items.some(item=>!item.name))return error("姓名不能为空",400);
  try{
    const assigned=await getDb().transaction(async tx=>{
      await lockTimekeeping(tx);
      const existing=await tx.select({badgeCode:timeEmployees.badgeCode,employeeCode:timeEmployees.employeeCode}).from(timeEmployees);
      const takenBadges=new Set(existing.map(row=>row.badgeCode));
      const takenEmployeeCodes=new Set(existing.flatMap(row=>row.employeeCode?[row.employeeCode]:[]));
      const next:{badgeCode:string;employeeCode:string;name:string;type:"OZM"|"JJC"}[]=[];
      for(const item of items){
        const badgeCode=await generateEmployeeId(item.name,item.type,takenBadges,LEGACY_EMPLOYEE_ID_LENGTH);
        const employeeCode=await generateEmployeeId(item.name,item.type,takenEmployeeCodes);
        takenBadges.add(badgeCode);takenEmployeeCodes.add(employeeCode);next.push({badgeCode,employeeCode,...item});
      }
      await tx.insert(timeEmployees).values(next.map(item=>({badgeCode:item.badgeCode,employeeCode:item.employeeCode,name:item.name,organizationType:item.type,createdAt:new Date().toISOString()})));
      await recordTimeRevision(tx);
      return next.map(item=>({badgeCode:item.employeeCode,name:item.name,type:item.type}));
    });
    const message=assigned.length===1?`员工 ${assigned[0].name} 已加入，员工 ID：${assigned[0].badgeCode}`:`已加入 ${assigned.length} 名员工并自动分配员工 ID`;
    return NextResponse.json({ok:true,message,employees:assigned},{status:201});
  }catch(cause){
    if((cause as {code?:string}).code==="23505")return error("员工 ID 发生并发冲突，请重新提交",409);
    throw cause;
  }
}

export async function PATCH(request:NextRequest){
  const access=await authorizePageAccess("time-employees");
  if(!access.authorized)return denied(access);
  await ensureTimekeepingSchema();
  const body=await request.json().catch(()=>({})) as EmployeeInput&{id?:unknown;active?:unknown;action?:unknown;requestId?:unknown};
  const id=Number(body.id);
  if(!Number.isInteger(id)||id<1)return error("员工记录无效",400);
  const action=body.action==="sign_in"||body.action==="sign_out"?body.action:null;
  if(body.action!==undefined&&!action)return error("考勤操作无效",400);
  if(action){
    const result=await performScan(access.user,{code:action==="sign_in"?"ACT-CLOCKIN":"ACT-OUT",employeeId:id,requestId:body.requestId,terminalId:"employee-list"});
    return NextResponse.json(result.response,{status:result.status,headers:{"cache-control":"no-store"}});
  }
  if(body.active!==undefined&&typeof body.active!=="boolean")return error("员工状态无效",400);
  const result=await getDb().transaction(async tx=>{
    await lockTimekeeping(tx);
    const current=(await tx.select().from(timeEmployees).where(eq(timeEmployees.id,id)).limit(1))[0];
    if(!current)return {error:"找不到员工记录",status:404 as const};
    if(body.active===false){
      const open=await tx.select({id:timeShifts.id}).from(timeShifts).where(and(eq(timeShifts.employeeId,id),eq(timeShifts.status,"open"))).limit(1);
      if(open.length)return {error:"员工仍在工作状态，不能停用",status:409 as const};
    }
    const input=normalizeEmployee({name:body.name??current.name,type:body.type??current.organizationType});
    if(!input.name)return {error:"姓名不能为空",status:400 as const};
    await tx.update(timeEmployees).set({name:input.name,organizationType:input.type,...(typeof body.active==="boolean"?{active:body.active}:{})}).where(eq(timeEmployees.id,id));
    await recordTimeRevision(tx);
    return {ok:true as const};
  });
  if(typeof result.error==="string")return error(result.error,result.status??400);
  return NextResponse.json({ok:true,message:"员工数据已更新"});
}

type EmployeeInput={name?:unknown;type?:unknown};
function normalizeEmployee(input:EmployeeInput){const type=String(input.type??"OZM").trim().toUpperCase();return {name:String(input.name??"").normalize("NFKC").trim().slice(0,80),type:type==="JJC"?"JJC" as const:"OZM" as const}}
function error(message:string,status:number){return NextResponse.json({ok:false,error:message},{status})}
function denied(access:{status:401|403;message:string}){return error(access.message,access.status)}
