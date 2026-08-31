import { NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../../lib/internal-auth";
import { createEmployeeScanExport } from "../../../../../../lib/timekeeping/employee-scan-export";
import { readEmployees } from "../../../../../../lib/timekeeping/read-model";

export const dynamic="force-dynamic";

export async function GET(){
  const access=await authorizePageAccess("time-employees");
  if(!access.authorized)return error(access.message,access.status);
  if(access.user.role!=="admin")return error("只有管理员可以导出员工扫描素材",403);
  const data=await readEmployees();
  const archive=await createEmployeeScanExport(data.employees);
  const encodedName=encodeURIComponent(archive.fileName);
  return new NextResponse(new Uint8Array(archive.buffer),{headers:{
    "cache-control":"no-store",
    "content-disposition":`attachment; filename="employee-scan-assets.zip"; filename*=UTF-8''${encodedName}`,
    "content-type":"application/zip",
  }});
}

function error(message:string,status:number){return NextResponse.json({ok:false,error:message},{status})}
