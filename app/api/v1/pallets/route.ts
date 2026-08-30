import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { locations, pallets, skus } from "../../../../db/schema";
import { authorizePageAccess } from "../../../../lib/internal-auth";

export async function GET(request: NextRequest) {
  const access=await authorizePageAccess("dashboard","reserve-inventory");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim();
  const status = params.get("status");
  const location = params.get("location");
  const conditions = [
    status ? eq(pallets.status, status as "in_stock" | "in_task" | "depleted") : undefined,
    location ? ilike(locations.code, `%${location}%`) : undefined,
    q ? or(ilike(skus.code, `%${q}%`), ilike(pallets.remarks, `%${q}%`), ilike(pallets.id, `%${q}%`), ilike(locations.code, `%${q}%`)) : undefined,
  ].filter(Boolean);

  const rows = await getDb().select({
    palletId: pallets.id, sku: skus.code, remarks: pallets.remarks,
    location: locations.code, status: pallets.status, inboundAt: pallets.inboundAt,
    ageDays: sql<number>`FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-${pallets.inboundAt}))/86400)::INTEGER`,
  }).from(pallets).innerJoin(skus, eq(pallets.skuId, skus.id))
    .leftJoin(locations, eq(pallets.locationId, locations.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(pallets.inboundAt)).limit(100);

  return NextResponse.json({ data: rows, meta: { count: rows.length, limit: 100 } });
}
