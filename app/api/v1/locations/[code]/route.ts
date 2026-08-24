import { and, eq, ne, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { locations, pallets } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { refreshLocationStatus } from "../../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function PATCH(request:NextRequest,{params}:{params:Promise<{code:string}>}) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const originalCode=decodeURIComponent((await params).code).trim().toUpperCase();
  const originalType=request.nextUrl.searchParams.get("type");
  if(!["reserve","pick"].includes(originalType??"")) {
    return NextResponse.json({error:{message:"请指定要编辑的库位类型"}},{status:400});
  }
  const body=await request.json().catch(()=>({})) as {code?:string;type?:"reserve"|"pick";zone?:string;capacity?:number};
  const db=getDb();
  const current=(await db.select().from(locations).where(and(
    eq(locations.code,originalCode),
    eq(locations.type,originalType as "reserve"|"pick"),
  )).limit(1))[0];
  if(!current) return NextResponse.json({error:{message:"库位不存在"}},{status:404});
  const code=body.code?.trim().toUpperCase()||current.code;
  const type=body.type??current.type;
  const zone=body.zone?.trim().toUpperCase()||current.zone;
  const capacity=body.capacity===undefined?current.capacity:Number(body.capacity);
  if(!code) return NextResponse.json({error:{message:"库位编码为必填项"}},{status:400});
  if(!["reserve","pick"].includes(type)) return NextResponse.json({error:{message:"库位类型无效"}},{status:400});
  if(!Number.isInteger(capacity)||capacity<1||capacity>999) return NextResponse.json({error:{message:"托盘容量必须是 1–999 的整数"}},{status:400});
  if((code!==current.code||type!==current.type)&&(await db.select({id:locations.id}).from(locations).where(and(eq(locations.code,code),eq(locations.type,type))).limit(1)).length) {
    return NextResponse.json({error:{message:`${type==="reserve"?"备货":"拣货"}库位编码已存在`}},{status:409});
  }
  const active=await db.select({count:sql<number>`count(*)`}).from(pallets)
    .where(and(eq(pallets.locationId,current.id),ne(pallets.status,"depleted")));
  const palletCount=Number(active[0]?.count??0);
  if(capacity<palletCount) {
    return NextResponse.json({error:{message:`当前已有 ${palletCount} 个托盘，容量不能低于该数量`}},{status:409});
  }
  if(type!==current.type&&palletCount>0) {
    return NextResponse.json({error:{message:"有托盘的库位不能修改库位类型"}},{status:409});
  }
  const [updated]=await db.update(locations).set({code,type,zone,capacity}).where(eq(locations.id,current.id)).returning();
  await refreshLocationStatus(current.id);
  await recordWarehouseRevision();
  return NextResponse.json({data:{...updated,palletCount}});
}
