import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { getTimeRevision } from "../../../../../lib/timekeeping/data";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-scan","time-dashboard","time-records","time-employees");
  if(!access.authorized)return NextResponse.json({ok:false,error:access.message},{status:access.status});
  const revision=await getTimeRevision();
  const etag=`"${revision}"`;
  const headers={"cache-control":"no-store",etag};
  if(request.headers.get("if-none-match")===etag)return new NextResponse(null,{status:304,headers});
  return NextResponse.json({ok:true,revision},{headers});
}
