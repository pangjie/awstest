import { NextResponse } from "next/server";
import { getInternalUser } from "../../../../lib/internal-auth";
import { getWarehouseRevision } from "../../../../lib/warehouse-revision";

export const dynamic="force-dynamic";

export async function GET() {
  if(!await getInternalUser())return NextResponse.json({error:{message:"请先登录"}},{status:401});
  return NextResponse.json({data:{revision:await getWarehouseRevision()}},{headers:{"cache-control":"no-store"}});
}
