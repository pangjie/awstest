import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { ensureTimekeepingSchema } from "../../../../../db/timekeeping-runtime";
import { timeWorkItems,timeWorkSessions } from "../../../../../db/timekeeping-schema";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { lockTimekeeping, recordTimeRevision } from "../../../../../lib/timekeeping/data";
import { readWorkItems } from "../../../../../lib/timekeeping/read-model";
import { normalizeCount, normalizeWaveCode, splitChannel } from "../../../../../lib/timekeeping/waves";

export const dynamic="force-dynamic";
const WAVE_NUMBER_PATTERN=/^W[A-Z0-9-]{8,}$/;

export async function GET(){
  const access=await authorizePageAccess("time-scan","time-dashboard");
  if(!access.authorized)return denied(access);
  return NextResponse.json(await readWorkItems(),{headers:{"cache-control":"no-store"}});
}

export async function POST(request:NextRequest){
  const access=await authorizePageAccess("time-dashboard");
  if(!access.authorized)return denied(access);
  await ensureTimekeepingSchema();
  const payload=await request.json().catch(()=>({})) as WorkItemInput&{items?:WorkItemInput[]};
  const rawItems=Array.isArray(payload.items)?payload.items:[payload];
  if(!rawItems.length||rawItems.length>250)return error("每次可导入 1–250 条波次",400);
  const requestDuplicates=new Set<string>();
  const seen=new Set<string>();
  const items=rawItems.map(normalizeItem).filter(item=>{if(seen.has(item.waveNo)){requestDuplicates.add(item.waveNo);return false}seen.add(item.waveNo);return true});
  if(items.some(item=>!WAVE_NUMBER_PATTERN.test(item.waveNo)))return error("波次缺少有效的波次号",400);
  try{
    const result=await getDb().transaction(async tx=>{
      await lockTimekeeping(tx);
      const existing=await tx.select({waveNo:timeWorkItems.waveNo,status:timeWorkItems.status}).from(timeWorkItems).where(inArray(timeWorkItems.waveNo,items.map(item=>item.waveNo)));
      const completed=existing.find(item=>item.status==="completed");
      if(completed)return {error:`波次 ${completed.waveNo} 已完结，不能重新导入`,status:409 as const};
      const existingNumbers=new Set(existing.map(item=>item.waveNo));
      const importable=items.filter(item=>!existingNumbers.has(item.waveNo));
      const skipped=Array.from(new Set([...requestDuplicates,...existingNumbers].filter((item):item is string=>Boolean(item))));
      if(!importable.length)return {imported:0,skipped};
      const max=(await tx.select({value:sql<number>`COALESCE(MAX(${timeWorkItems.sortOrder}),0)`}).from(timeWorkItems).where(eq(timeWorkItems.workType,"wave")))[0];
      const createdAt=new Date().toISOString();
      await tx.insert(timeWorkItems).values(importable.map((item,index)=>({...item,sortOrder:Number(max?.value??0)+index+1,status:"active" as const,createdAt})));
      await recordTimeRevision(tx);
      return {imported:importable.length,skipped};
    });
    if(typeof result.error==="string")return error(result.error,result.status??400);
    const suffix=result.skipped.length?`，跳过重复波次 ${result.skipped.join("、")}`:"";
    return NextResponse.json({ok:true,...result,message:result.imported?`已保存 ${result.imported} 个当前波次${suffix}`:`没有新增波次${suffix}`},{status:result.imported?201:200});
  }catch(cause){
    if((cause as {code?:string}).code==="23505")return error("波次号与现有记录重复",409);
    throw cause;
  }
}

export async function PATCH(request:NextRequest){
  const access=await authorizePageAccess("time-dashboard");
  if(!access.authorized)return denied(access);
  await ensureTimekeepingSchema();
  const body=await request.json().catch(()=>({})) as {id?:unknown;action?:unknown};
  const id=Number(body.id);
  const action=body.action==="complete"||body.action==="interrupt"?body.action:null;
  if(!Number.isInteger(id)||id<1||!action)return error("波次操作无效",400);
  const result=await getDb().transaction(async tx=>{
    await lockTimekeeping(tx);
    const wave=(await tx.select().from(timeWorkItems).where(and(eq(timeWorkItems.id,id),eq(timeWorkItems.workType,"wave"))).limit(1))[0];
    if(!wave)return {error:"找不到这个波次",status:404 as const};
    if(wave.status==="completed")return action==="complete"?{message:"这个波次已经完结"}:{error:"已完结波次不能中断",status:409 as const};
    if(action==="interrupt"&&wave.interruptedAt)return {message:"这个波次已经中断"};
    const activeSessions=await tx.select({id:timeWorkSessions.id}).from(timeWorkSessions).where(and(eq(timeWorkSessions.workItemId,id),isNull(timeWorkSessions.endedAt))).limit(1);
    if(action==="interrupt"&&!activeSessions.length)return {error:"只有正在进行的波次可以中断",status:409 as const};
    const now=new Date().toISOString();
    await tx.update(timeWorkSessions).set({endedAt:now}).where(and(eq(timeWorkSessions.workItemId,id),isNull(timeWorkSessions.endedAt)));
    await tx.update(timeWorkItems).set(action==="complete"?{status:"completed",completedAt:now,interruptedAt:null}:{interruptedAt:now}).where(eq(timeWorkItems.id,id));
    await recordTimeRevision(tx);
    return {message:action==="complete"?`波次 ${wave.waveNo} 已完结并移入历史记录`:`波次 ${wave.waveNo} 已中断，参与人员已转为在岗待命`};
  });
  if(typeof result.error==="string")return error(result.error,result.status??400);
  return NextResponse.json({ok:true,message:result.message});
}

export async function DELETE(request:NextRequest){
  const access=await authorizePageAccess("time-dashboard");
  if(!access.authorized)return denied(access);
  await ensureTimekeepingSchema();
  const id=Number(request.nextUrl.searchParams.get("id"));
  if(!Number.isInteger(id)||id<1)return error("波次记录无效",400);
  const result=await getDb().transaction(async tx=>{
    await lockTimekeeping(tx);
    const wave=(await tx.select().from(timeWorkItems).where(and(eq(timeWorkItems.id,id),eq(timeWorkItems.workType,"wave"))).limit(1))[0];
    if(!wave||wave.status!=="active")return {error:"只能移除当前波次",status:409 as const};
    const used=await tx.select({id:timeWorkSessions.id}).from(timeWorkSessions).where(eq(timeWorkSessions.workItemId,id)).limit(1);
    if(used.length)return {error:"这个波次已有工时记录，请使用“完结”保留历史",status:409 as const};
    await tx.delete(timeWorkItems).where(eq(timeWorkItems.id,id));
    await recordTimeRevision(tx);
    return {message:`未操作波次 ${wave.waveNo} 已移除`};
  });
  if(typeof result.error==="string")return error(result.error,result.status??400);
  return NextResponse.json({ok:true,message:result.message});
}

type WorkItemInput={barcode?:unknown;code?:unknown;waveNo?:unknown;client?:unknown;channelName?:unknown;channelType?:unknown;skuCount?:unknown;orderCount?:unknown;pieceCount?:unknown};
function normalizeItem(item:WorkItemInput){const waveNo=normalizeWaveCode(item.waveNo)||normalizeWaveCode(item.barcode)||normalizeWaveCode(item.code);const channel=splitChannel(String(item.channelName??item.client??"").slice(0,80)||"其他",item.channelType);return {barcode:waveNo,code:waveNo,waveNo,name:`${channel.name} · ${channel.type}`,client:channel.name,channelName:channel.name,channelType:channel.type,workType:"wave" as const,skuCount:normalizeCount(item.skuCount),orderCount:normalizeCount(item.orderCount),pieceCount:normalizeCount(item.pieceCount)}}
function error(message:string,status:number){return NextResponse.json({ok:false,error:message},{status})}
function denied(access:{status:401|403;message:string}){return error(access.message,access.status)}
