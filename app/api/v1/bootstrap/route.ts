import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { locations, movements, pallets, skuCatalog, skus, taskItems, tasks, users } from "../../../../db/schema";
import { getInternalUser } from "../../../../lib/internal-auth";
import { getTaskDetailRows } from "../../../../lib/warehouse-read-model";
import { previousWarehouseDateKey, warehouseDateKey, warehouseDateTimeInputToIso } from "../../../../lib/warehouse-time";
import { getWarehouseRevision } from "../../../../lib/warehouse-revision";

export const dynamic="force-dynamic";

export async function GET() {
  const currentUser=await getInternalUser();
  if(!currentUser) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const db=getDb();
  const now=new Date();
  const today=warehouseDateKey(now);
  const recentStart=warehouseDateTimeInputToIso(`${previousWarehouseDateKey(now)}T00:00`);

  const palletQuery=db.select({
    id:pallets.id,skuId:skus.id,sku:skus.code,remarks:pallets.remarks,
    locationId:locations.id,location:locations.code,status:pallets.status,inboundAt:pallets.inboundAt,
    ageDays:sql<number>`FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-${pallets.inboundAt}))/86400)::INTEGER`,
  }).from(pallets).innerJoin(skus,eq(pallets.skuId,skus.id)).leftJoin(locations,eq(pallets.locationId,locations.id))
    .where(sql`${pallets.status} != 'depleted'`).orderBy(desc(pallets.inboundAt),desc(pallets.id));

  const locationQuery=db.select({
    id:locations.id,code:locations.code,type:locations.type,zone:locations.zone,capacity:locations.capacity,status:locations.status,
    palletCount:sql<number>`(SELECT COUNT(*) FROM pallets p WHERE p.location_id = locations.id AND p.status != 'depleted')`,
  }).from(locations).where(eq(locations.type,"reserve")).orderBy(locations.code);

  const recentMovementQuery=db.select({
    id:movements.id,palletId:movements.palletId,sku:skus.code,remarks:pallets.remarks,taskId:tasks.id,operator:users.name,
    action:movements.action,quantity:movements.quantity,occurredAt:movements.occurredAt,
    fromLocation:sql<string|null>`fl.code`,fromLocationType:sql<"reserve"|"pick"|null>`fl.type`,
    toLocation:sql<string|null>`tl.code`,toLocationType:sql<"reserve"|"pick"|null>`tl.type`,
  }).from(movements).innerJoin(skus,eq(movements.skuId,skus.id))
    .leftJoin(pallets,eq(movements.palletId,pallets.id))
    .leftJoin(tasks,eq(movements.taskId,tasks.id)).leftJoin(users,eq(movements.operatorId,users.id))
    .leftJoin(sql`${locations} AS fl`,sql`fl.id = ${movements.fromLocationId}`)
    .leftJoin(sql`${locations} AS tl`,sql`tl.id = ${movements.toLocationId}`)
    .where(gte(movements.occurredAt,recentStart))
    .orderBy(desc(movements.occurredAt),desc(movements.id));

  const invalidSkuQuery=db.selectDistinct({code:skus.code}).from(skus)
    .innerJoin(pallets,eq(pallets.skuId,skus.id))
    .where(and(
      ne(pallets.status,"depleted"),
      sql`NOT EXISTS (
        SELECT 1 FROM ${skuCatalog}
        WHERE ${skuCatalog.code} = ${skus.code} AND ${skuCatalog.active} = TRUE
      )`,
    )).orderBy(skus.code);

  const recentlyResolvedQuery=db.select({resolvedAt:taskItems.resolvedAt}).from(taskItems)
    .where(and(sql`${taskItems.resolvedAt} IS NOT NULL`,gte(taskItems.resolvedAt,recentStart)));

  const [palletRows,taskRows,locationRows,movementRows,userRows,invalidSkuRows,recentlyResolvedRows,revision]=await Promise.all([
    palletQuery,
    getTaskDetailRows("pending"),
    locationQuery,
    recentMovementQuery,
    currentUser.role==="admin"?db.select({
      id:users.id,username:users.username,email:users.email,name:users.name,role:users.role,active:users.active,
    }).from(users).orderBy(users.name):Promise.resolve([]),
    invalidSkuQuery,
    recentlyResolvedQuery,
    getWarehouseRevision(),
  ]);

  const completedToday=recentlyResolvedRows.filter(row=>row.resolvedAt&&warehouseDateKey(row.resolvedAt)===today).length;
  const reserveRows=locationRows.filter(location=>location.type==="reserve");
  const reserveCapacity=reserveRows.reduce((total,location)=>total+location.capacity,0);
  const occupiedSlots=reserveRows.reduce((total,location)=>total+Number(location.palletCount),0);
  return NextResponse.json({data:{
    pallets:palletRows,tasks:taskRows,locations:locationRows,movements:movementRows,users:userRows,
    invalidSkuCodes:invalidSkuRows.map(row=>row.code),revision,
    stats:{pallets:palletRows.length,occupied:occupiedSlots,
      reserveLocations:reserveRows.length,reserveCapacity,pendingTasks:new Set(taskRows.map(t=>t.id)).size,
      completedToday},
  }},{headers:{"cache-control":"no-store"}});
}
