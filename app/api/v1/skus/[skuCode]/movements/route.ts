import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { locations, movements, pallets, skus } from "../../../../../../db/schema";
import { getInternalUser } from "../../../../../../lib/internal-auth";

export async function GET(_:Request,{params}:{params:Promise<{skuCode:string}>}) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const {skuCode}=await params;
  const rows=await getDb().select({
    id:movements.id,palletId:movements.palletId,sku:skus.code,remarks:pallets.remarks,taskId:movements.taskId,
    action:movements.action,quantity:movements.quantity,occurredAt:movements.occurredAt,
    fromLocation:sql<string|null>`fl.code`,fromLocationType:sql<"reserve"|"pick"|null>`fl.type`,
    toLocation:sql<string|null>`tl.code`,toLocationType:sql<"reserve"|"pick"|null>`tl.type`,
  }).from(movements).innerJoin(skus,eq(movements.skuId,skus.id)).leftJoin(pallets,eq(movements.palletId,pallets.id))
    .leftJoin(sql`${locations} AS fl`,sql`fl.id = ${movements.fromLocationId}`)
    .leftJoin(sql`${locations} AS tl`,sql`tl.id = ${movements.toLocationId}`)
    .where(eq(skus.code,decodeURIComponent(skuCode).toUpperCase())).orderBy(desc(movements.occurredAt),desc(movements.id));
  if(!rows.length) {
    const exists=await getDb().select({id:skus.id}).from(skus).where(eq(skus.code,decodeURIComponent(skuCode).toUpperCase())).limit(1);
    if(!exists.length) return NextResponse.json({error:{message:"SKU 不存在"}},{status:404});
  }
  return NextResponse.json({data:rows,meta:{count:rows.length}});
}
