import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { locations, movements, pallets, skus, tasks, users } from "../../../../db/schema";
import { getInternalUser } from "../../../../lib/internal-auth";

export async function GET(request:NextRequest) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const params=request.nextUrl.searchParams;
  const q=params.get("q")?.trim();
  const sku=params.get("sku")?.trim();
  const pallet=params.get("pallet")?.trim();
  const location=params.get("location")?.trim();
  const action=params.get("action");
  const from=params.get("from");
  const to=params.get("to");
  const limit=Math.min(1000,Math.max(1,Number(params.get("limit"))||100));
  const offset=Math.max(0,Number(params.get("offset"))||0);
  const conditions=[
    sku?ilike(skus.code,`%${sku}%`):undefined,
    pallet?ilike(movements.palletId,`%${pallet}%`):undefined,
    action?eq(movements.action,action as typeof movements.action.enumValues[number]):undefined,
    from?gte(movements.occurredAt,from):undefined,
    to?lte(movements.occurredAt,to):undefined,
    location?sql`(fl.code ILIKE ${`%${location}%`} OR tl.code ILIKE ${`%${location}%`})`:undefined,
    q?or(ilike(skus.code,`%${q}%`),ilike(pallets.remarks,`%${q}%`),ilike(movements.palletId,`%${q}%`),sql`fl.code ILIKE ${`%${q}%`}`,sql`tl.code ILIKE ${`%${q}%`}`):undefined,
  ].filter((value):value is NonNullable<typeof value>=>Boolean(value));
  const rows=await getDb().select({
    id:movements.id,palletId:movements.palletId,sku:skus.code,remarks:pallets.remarks,taskId:tasks.id,
    action:movements.action,quantity:movements.quantity,occurredAt:movements.occurredAt,
    fromLocation:sql<string|null>`fl.code`,fromLocationType:sql<"reserve"|"pick"|null>`fl.type`,
    toLocation:sql<string|null>`tl.code`,toLocationType:sql<"reserve"|"pick"|null>`tl.type`,operator:users.name,
  }).from(movements).innerJoin(skus,eq(movements.skuId,skus.id)).leftJoin(pallets,eq(movements.palletId,pallets.id)).leftJoin(tasks,eq(movements.taskId,tasks.id))
    .leftJoin(users,eq(movements.operatorId,users.id))
    .leftJoin(sql`${locations} AS fl`,sql`fl.id = ${movements.fromLocationId}`)
    .leftJoin(sql`${locations} AS tl`,sql`tl.id = ${movements.toLocationId}`)
    .where(conditions.length?and(...conditions):undefined).orderBy(desc(movements.occurredAt),desc(movements.id)).limit(limit).offset(offset);
  return NextResponse.json({data:rows,meta:{count:rows.length,limit,offset,nextOffset:rows.length===limit?offset+limit:null}});
}
