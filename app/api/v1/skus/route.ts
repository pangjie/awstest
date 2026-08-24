import { and, like, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { skus } from "../../../../db/schema";
import { getInternalUser } from "../../../../lib/internal-auth";

export async function GET(request:NextRequest) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const q=request.nextUrl.searchParams.get("q")?.trim();
  const words=q?.split(/\s+/).filter(Boolean)??[];
  const conditions=words.map(word=>like(skus.code,`%${word}%`));
  const rows=await getDb().select({
    id:skus.id,sku:skus.code,unit:skus.unit,createdAt:skus.createdAt,
    palletCount:sql<number>`(SELECT COUNT(*) FROM pallets p WHERE p.sku_id = ${skus.id} AND p.status != 'depleted')`,
    movementCount:sql<number>`(SELECT COUNT(*) FROM movements m WHERE m.sku_id = ${skus.id})`,
    lastMovementAt:sql<string|null>`(SELECT MAX(m.occurred_at) FROM movements m WHERE m.sku_id = ${skus.id})`,
  }).from(skus).where(conditions.length?and(...conditions):undefined).orderBy(skus.code);
  return NextResponse.json({data:rows,meta:{count:rows.length}});
}
