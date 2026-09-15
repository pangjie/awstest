import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { performScan, type ScanInput } from "../../../../../lib/timekeeping/scan";
import { readTodayScanOperations, readWorkItems } from "../../../../../lib/timekeeping/read-model";
import { getEmployeeSnapshot, getTimeRevision } from "../../../../../lib/timekeeping/data";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-scan");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  const employeeId=request.nextUrl.searchParams.get("employeeId");
  if(employeeId!==null&&(!/^\d+$/.test(employeeId)||!Number.isSafeInteger(Number(employeeId))||Number(employeeId)<1))return NextResponse.json({ok:false,error:"员工编号无效"},{status:400});
  // Capture the revision before reading so concurrent changes are caught by the next poll.
  const revision=await getTimeRevision();
  const [items,todayOperations,snapshot]=await Promise.all([readWorkItems({includeHistory:false}),readTodayScanOperations(),employeeId?getEmployeeSnapshot(Number(employeeId)):null]);
  return NextResponse.json({...items,revision,snapshot,historyWaves:[],todayOperations},{headers:{"cache-control":"no-store"}});
}

export async function POST(request:NextRequest){
  const access=await authorizePageAccess("time-scan");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  const input=await request.json().catch(()=>({})) as ScanInput;
  const result=await performScan(access.user,input);
  return NextResponse.json(result.response,{status:result.status,headers:{"cache-control":"no-store"}});
}
