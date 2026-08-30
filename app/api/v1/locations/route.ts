import { and, eq, inArray, like, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { locations } from "../../../../db/schema";
import { authorizePageAccess } from "../../../../lib/internal-auth";
import { normalizeLocationImportRow, validateUniqueLocationImportRows } from "../../../../lib/location-import";
import { lockWarehouseInventory } from "../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../lib/warehouse-revision";

export async function GET(request:NextRequest) {
  const access=await authorizePageAccess("dashboard","reserve-inventory","location-management","warehouse-ledger");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const params=request.nextUrl.searchParams;
  const q=params.get("q")?.trim();
  const type=params.get("type");
  const zone=params.get("zone");
  const status=params.get("status");
  const compact=params.get("compact")==="1";
  const conditions=[
    q?like(locations.code,`%${q}%`):undefined,
    type?eq(locations.type,type as typeof locations.type.enumValues[number]):undefined,
    zone?eq(locations.zone,zone):undefined,
    status?eq(locations.status,status as typeof locations.status.enumValues[number]):undefined,
  ].filter((value):value is NonNullable<typeof value>=>Boolean(value));
  if(compact) {
    const rows=await getDb().select({
      id:locations.id,code:locations.code,type:locations.type,zone:locations.zone,capacity:locations.capacity,status:locations.status,
      palletCount:sql<number>`(SELECT COUNT(*) FROM pallets p WHERE p.location_id = locations.id AND p.status != 'depleted')`,
    }).from(locations).where(conditions.length?and(...conditions):undefined).orderBy(locations.code);
    return NextResponse.json({data:rows,meta:{count:rows.length}},{headers:{"cache-control":"no-store"}});
  }
  const rows=await getDb().select({
    id:locations.id,code:locations.code,type:locations.type,zone:locations.zone,capacity:locations.capacity,status:locations.status,
    palletCount:sql<number>`(SELECT COUNT(*) FROM pallets p WHERE p.location_id = locations.id AND p.status != 'depleted')`,
    skuCount:sql<number>`(SELECT COUNT(DISTINCT p.sku_id) FROM pallets p WHERE p.location_id = locations.id AND p.status != 'depleted')`,
    movementCount:sql<number>`(SELECT COUNT(*) FROM movements m WHERE m.from_location_id = locations.id OR m.to_location_id = locations.id)`,
  }).from(locations).where(conditions.length?and(...conditions):undefined).orderBy(locations.code);
  return NextResponse.json({data:rows,meta:{count:rows.length}});
}

export async function POST(request:NextRequest) {
  const access=await authorizePageAccess("location-management");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const body=await request.json().catch(()=>({})) as {
    action?:"import";
    code?:string;
    type?:"reserve"|"pick";
    zone?:string;
    capacity?:number;
    rows?:Array<Record<string,unknown>>;
  };
  if(body.action==="import") {
    try {
      if(!Array.isArray(body.rows))throw new Error("没有收到可导入的库位数据");
      const normalized=body.rows.flatMap((row,index)=>{
        const item=normalizeLocationImportRow({
          "库位":row.code,"类型":row.type,"容量":row.capacity,
        },Number(row.sourceRow)||index+2);
        return item?[item]:[];
      });
      validateUniqueLocationImportRows(normalized);
      const payload=normalized.map(row=>({
        code:row.code,type:row.type,capacity:row.capacity,zone:row.code.split("-")[0]||"A",
      }));
      const requestedByKey=new Map(payload.map(row=>[`${row.type}:${row.code}`,row]));
      const db=getDb();
      const result=await db.transaction(async tx=>{
        await lockWarehouseInventory(tx);
        const existingRows=await tx.select({
          code:locations.code,type:locations.type,
          palletCount:sql<number>`(SELECT COUNT(*) FROM pallets p WHERE p.location_id = locations.id AND p.status != 'depleted')`,
        }).from(locations).where(inArray(locations.code,Array.from(new Set(payload.map(row=>row.code)))));
        const matchingExisting=existingRows.filter(row=>requestedByKey.has(`${row.type}:${row.code}`));
        const capacityConflict=matchingExisting.map(row=>({
          ...row,requestedCapacity:requestedByKey.get(`${row.type}:${row.code}`)!.capacity,
        })).find(row=>Number(row.palletCount)>row.requestedCapacity);
        if(capacityConflict) {
          return {error:`${capacityConflict.code}（${capacityConflict.type==="reserve"?"备货库位":"拣货库位"}）当前占用 ${capacityConflict.palletCount} 托，容量不能改为 ${capacityConflict.requestedCapacity}`};
        }
        for(let offset=0;offset<payload.length;offset+=500) {
          await tx.insert(locations).values(payload.slice(offset,offset+500).map(row=>({...row,status:"available" as const})))
            .onConflictDoUpdate({
              target:[locations.code,locations.type],
              set:{capacity:sql`excluded.capacity`,zone:sql`excluded.zone`},
            });
        }
        await recordWarehouseRevision(tx);
        return {data:{importedRows:normalized.length,createdRows:normalized.length-matchingExisting.length,updatedRows:matchingExisting.length}};
      });
      if("error" in result)return NextResponse.json({error:{message:result.error}},{status:409});
      return NextResponse.json(result);
    } catch(error) {
      return NextResponse.json({error:{message:error instanceof Error?error.message:"库位批量导入失败"}},{status:400});
    }
  }
  const code=body.code?.trim().toUpperCase()??"";
  const type=body.type==="pick"?"pick":"reserve";
  const zone=body.zone?.trim().toUpperCase()||code.split("-")[0]||"A";
  const capacity=Number(body.capacity??1);
  if(!code) return NextResponse.json({error:{message:"库位编码为必填项"}},{status:400});
  if(!Number.isInteger(capacity)||capacity<1||capacity>999) return NextResponse.json({error:{message:"托盘容量必须是 1–999 的整数"}},{status:400});
  const result=await getDb().transaction(async tx=>{
    await lockWarehouseInventory(tx);
    if((await tx.select({id:locations.id}).from(locations).where(and(eq(locations.code,code),eq(locations.type,type))).limit(1)).length) {
      return {error:`${type==="reserve"?"备货":"拣货"}库位编码已存在`};
    }
    const [created]=await tx.insert(locations).values({code,type,zone,capacity,status:"available"}).returning();
    await recordWarehouseRevision(tx);
    return {data:{...created,palletCount:0}};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:409});
  return NextResponse.json(result,{status:201});
}
