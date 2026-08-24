import { and, asc, eq, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { locations, movements, pallets, skus } from "../../../../../../db/schema";
import { getInternalUser } from "../../../../../../lib/internal-auth";

export async function GET(request:NextRequest,{params}:{params:Promise<{code:string}>}) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const {code}=await params;
  const db=getDb();
  const requestedType=request.nextUrl.searchParams.get("type");
  if(!["reserve","pick"].includes(requestedType??"")) {
    return NextResponse.json({error:{message:"请指定库位类型"}},{status:400});
  }
  const location=(await db.select().from(locations).where(and(
    eq(locations.code,decodeURIComponent(code).toUpperCase()),
    eq(locations.type,requestedType as "reserve"|"pick"),
  )).limit(1))[0];
  if(!location) return NextResponse.json({error:{message:"库位不存在"}},{status:404});
  const rows=await db.select({
    id:movements.id,palletId:movements.palletId,sku:skus.code,remarks:pallets.remarks,taskId:movements.taskId,
    action:movements.action,quantity:movements.quantity,occurredAt:movements.occurredAt,
    fromLocation:sql<string|null>`fl.code`,fromLocationType:sql<"reserve"|"pick"|null>`fl.type`,
    toLocation:sql<string|null>`tl.code`,toLocationType:sql<"reserve"|"pick"|null>`tl.type`,
  }).from(movements).innerJoin(skus,eq(movements.skuId,skus.id)).leftJoin(pallets,eq(movements.palletId,pallets.id))
    .leftJoin(sql`${locations} AS fl`,sql`fl.id = ${movements.fromLocationId}`)
    .leftJoin(sql`${locations} AS tl`,sql`tl.id = ${movements.toLocationId}`)
    .where(or(eq(movements.fromLocationId,location.id),eq(movements.toLocationId,location.id)))
    .orderBy(asc(movements.occurredAt),asc(movements.id));
  const open=new Map<string,{palletId:string;sku:string;remarks:string;from:string}>();
  const periods:Array<{palletId:string;sku:string;remarks:string;from:string;to:string|null}>=[];
  for(const row of rows) {
    const arrives=row.toLocation===location.code&&row.toLocationType===location.type
      &&!(row.fromLocation===location.code&&row.fromLocationType===location.type);
    const partialPick=row.action==="partial_pick";
    const departs=row.fromLocation===location.code&&row.fromLocationType===location.type
      &&!(row.toLocation===location.code&&row.toLocationType===location.type)&&!partialPick;
    if(arrives&&!open.has(row.palletId)) open.set(row.palletId,{palletId:row.palletId,sku:row.sku,remarks:row.remarks??"",from:row.occurredAt});
    if(departs) {
      const period=open.get(row.palletId);
      if(period){periods.push({...period,to:row.occurredAt});open.delete(row.palletId)}
    }
  }
  periods.push(...Array.from(open.values()).map(period=>({...period,to:null})));
  const search=request.nextUrl.searchParams;
  const from=search.get("from"),to=search.get("to"),sku=search.get("sku")?.toLowerCase();
  const events=rows.filter(row=>(!from||row.occurredAt>=from)&&(!to||row.occurredAt<=to)&&(!sku||`${row.sku} ${row.remarks}`.toLowerCase().includes(sku))).reverse();
  const filteredPeriods=periods.filter(period=>(!from||!period.to||period.to>=from)&&(!to||period.from<=to)&&(!sku||`${period.sku} ${period.remarks}`.toLowerCase().includes(sku)));
  return NextResponse.json({data:{location,periods:filteredPeriods,events},meta:{periodCount:filteredPeriods.length,eventCount:events.length}});
}
