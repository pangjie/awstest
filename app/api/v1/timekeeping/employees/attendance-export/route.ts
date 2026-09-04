import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../../lib/internal-auth";
import { readAttendanceExport } from "../../../../../../lib/timekeeping/read-model";
import type { AttendanceExportScope } from "../../../../../../lib/timekeeping/time";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-employees");
  if(!access.authorized)return error(access.message,access.status);
  const period=request.nextUrl.searchParams.get("period")??"";
  const requestedScope=request.nextUrl.searchParams.get("scope")??"month";
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))return error("请选择有效的自然月",400);
  if(!["month","first-half","second-half"].includes(requestedScope))return error("考勤导出范围无效",400);
  return NextResponse.json(await readAttendanceExport(period,requestedScope as AttendanceExportScope),{headers:{"cache-control":"no-store"}});
}

function error(message:string,status:number){return NextResponse.json({ok:false,error:message},{status})}
