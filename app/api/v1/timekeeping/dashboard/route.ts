import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { readDashboard } from "../../../../../lib/timekeeping/read-model";

import { getPool } from "@/db";
import { workDate } from "@/lib/timekeeping/time";
import { parseExportQuery } from "@/lib/wave-export-contract";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-dashboard");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  const data=await readDashboard(request.nextUrl.searchParams.get("startDate"),request.nextUrl.searchParams.get("endDate"));
  const date=workDate(),range=parseExportQuery(new URLSearchParams({date}));
  const {rows}=await getPool().query<{ready:boolean}>(`SELECT count(*)>0 AND bool_and(status='completed') AS ready FROM time_work_items WHERE work_type='wave' AND created_at >= $1 AND created_at < $2`,[range.start,range.end]);
  return NextResponse.json({...data,todayExport:{date,ready:rows[0].ready}},{headers:{"cache-control":"no-store"}});
}
