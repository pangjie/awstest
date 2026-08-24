import { and, eq, ne, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { locations, pallets } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { lockWarehouseInventory, refreshLocationStatus } from "../../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function PATCH(request:NextRequest,{params}:{params:Promise<{code:string}>}) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const originalCode=decodeURIComponent((await params).code).trim().toUpperCase();
  const originalType=request.nextUrl.searchParams.get("type");
  if(!["reserve","pick"].includes(originalType??"")) {
    return NextResponse.json({error:{message:"请指定要编辑的库位类型"}},{status:400});
  }
  const body=await request.json().catch(()=>({})) as {code?:string;type?:"reserve"|"pick";zone?:string;capacity?:number};
  const result=await getDb().transaction(async tx=>{
    await lockWarehouseInventory(tx);
    const current=(await tx.select().from(locations).where(and(
      eq(locations.code,originalCode),
      eq(locations.type,originalType as "reserve"|"pick"),
    )).limit(1))[0];
    if(!current)return {error:"库位不存在",status:404 as const};
    const code=body.code?.trim().toUpperCase()||current.code;
    const type=body.type??current.type;
    const zone=body.zone?.trim().toUpperCase()||current.zone;
    const capacity=body.capacity===undefined?current.capacity:Number(body.capacity);
    if(!code)return {error:"库位编码为必填项",status:400 as const};
    if(!["reserve","pick"].includes(type))return {error:"库位类型无效",status:400 as const};
    if(!Number.isInteger(capacity)||capacity<1||capacity>999)return {error:"托盘容量必须是 1–999 的整数",status:400 as const};
    if((code!==current.code||type!==current.type)&&(await tx.select({id:locations.id}).from(locations).where(and(eq(locations.code,code),eq(locations.type,type))).limit(1)).length) {
      return {error:`${type==="reserve"?"备货":"拣货"}库位编码已存在`,status:409 as const};
    }
    const active=await tx.select({count:sql<number>`count(*)`}).from(pallets)
      .where(and(eq(pallets.locationId,current.id),ne(pallets.status,"depleted")));
    const palletCount=Number(active[0]?.count??0);
    if(capacity<palletCount)return {error:`当前已有 ${palletCount} 个托盘，容量不能低于该数量`,status:409 as const};
    if(type!==current.type&&palletCount>0)return {error:"有托盘的库位不能修改库位类型",status:409 as const};
    const [updated]=await tx.update(locations).set({code,type,zone,capacity}).where(eq(locations.id,current.id)).returning();
    await refreshLocationStatus(current.id,tx);
    await recordWarehouseRevision(tx);
    return {data:{...updated,palletCount}};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result);
}
