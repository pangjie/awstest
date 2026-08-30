import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { performScan, type ScanInput } from "../../../../../lib/timekeeping/scan";
import { readTodayScanOperations, readWorkItems } from "../../../../../lib/timekeeping/read-model";

export const dynamic="force-dynamic";

export async function GET(){
  const access=await authorizePageAccess("time-scan");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  const [items,todayOperations]=await Promise.all([readWorkItems({includeHistory:false}),readTodayScanOperations()]);
  return NextResponse.json({...items,historyWaves:[],todayOperations},{headers:{"cache-control":"no-store"}});
}

export async function POST(request:NextRequest){
  const access=await authorizePageAccess("time-scan");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  const input=await request.json().catch(()=>({})) as ScanInput;
  const result=await performScan(access.user,input);
  return NextResponse.json(result.response,{status:result.status,headers:{"cache-control":"no-store"}});
}
