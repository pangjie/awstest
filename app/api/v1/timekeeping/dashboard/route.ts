import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { readDashboard } from "../../../../../lib/timekeeping/read-model";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-dashboard");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  return NextResponse.json(await readDashboard(request.nextUrl.searchParams.get("date"),request.nextUrl.searchParams.get("range")),{headers:{"cache-control":"no-store"}});
}
