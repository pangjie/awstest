import { NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../lib/internal-auth";
import { ALL_PAGE_KEYS } from "../../../../lib/page-permissions";
import { getWarehouseRevision } from "../../../../lib/warehouse-revision";

export const dynamic="force-dynamic";

export async function GET() {
  const access=await authorizePageAccess(...ALL_PAGE_KEYS);
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  return NextResponse.json({data:{revision:await getWarehouseRevision()}},{headers:{"cache-control":"no-store"}});
}
