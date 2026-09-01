import { NextRequest, NextResponse } from "next/server";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { isValidEmployeeId, sanitizeEmployeeId } from "../../../../../lib/timekeeping/employee-id";
import { readEmployeeReport } from "../../../../../lib/timekeeping/read-model";
import { performScan, type ScanInput } from "../../../../../lib/timekeeping/scan";
import { workDate } from "../../../../../lib/timekeeping/time";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-card-scan");
  if(!access.authorized)return denied(access);
  const badge=sanitizeEmployeeId(request.nextUrl.searchParams.get("badge")??"");
  if(!isValidEmployeeId(badge))return error("请输入有效的员工 ID",400);
  const report=await readEmployeeReport(badge);
  if(!report)return error("未找到这个员工 ID",404);
  const today=workDate();
  return NextResponse.json({
    ok:true,generatedAt:report.generatedAt,workDate:today,snapshot:report.snapshot,
    attendanceEvents:report.attendanceEvents.filter(event=>event.workDate===today),
    projects:report.projects.filter(project=>project.workDate===today),
  },{headers:{"cache-control":"no-store"}});
}

export async function POST(request:NextRequest){
  const access=await authorizePageAccess("time-card-scan");
  if(!access.authorized)return denied(access);
  const input=await request.json().catch(()=>({})) as ScanInput;
  const code=String(input.code??"").normalize("NFKC").trim().toUpperCase();
  if(code!=="ACT-CLOCKIN"&&code!=="ACT-OUT")return error("工卡扫描只能执行 Sign In 或 Sign Out",400);
  const result=await performScan(access.user,{code,employeeId:input.employeeId,requestId:input.requestId,terminalId:"mobile-card"});
  return NextResponse.json(result.response,{status:result.status,headers:{"cache-control":"no-store"}});
}

function error(message:string,status:number){return NextResponse.json({ok:false,error:message},{status})}
function denied(access:{status:401|403;message:string}){return error(access.message,access.status)}
