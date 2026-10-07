import { randomUUID } from "node:crypto";
import { getPool } from "@/db";
import { ExportError,EXPORT_LIMITS,parseExportQuery } from "@/lib/wave-export-contract";
import { consumeQuota,ensureExportQuotaSchema } from "@/lib/wave-export-quota";
import { readExportWaves } from "@/lib/wave-export-data";
import { buildWaveWorkbook,exportMetadata } from "@/lib/wave-export-workbook";

export const runtime="nodejs";
export const dynamic="force-dynamic";
let active=false;
let attempts:{at:number;count:number}={at:0,count:0};
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};

export async function GET(request:Request){
  const started=Date.now(),requestId=randomUUID();
  let range:ReturnType<typeof parseExportQuery>|undefined;
  let quota:Awaited<ReturnType<typeof consumeQuota>>|undefined;
  let status=500,count=0;
  const responseHeaders=new Headers({...headers,"X-Request-Id":requestId});
  try{
    if(Date.now()-attempts.at>=60_000)attempts={at:Date.now(),count:0};
    if(++attempts.count>120)throw new ExportError(429,"REQUEST_RATE_LIMIT","Too many requests",Math.max(1,Math.ceil((attempts.at+60_000-Date.now())/1000)));
    range=parseExportQuery(new URL(request.url).searchParams);
    if(active)throw new ExportError(429,"EXPORT_BUSY","Another export is running; retry later",5);
    active=true;
    try{
      await ensureExportQuotaSchema();
      const client=await getPool().connect();
      let locked=false;
      try{
        locked=(await client.query("SELECT pg_try_advisory_lock(741203,2) AS acquired")).rows[0].acquired;
        if(!locked)throw new ExportError(429,"EXPORT_BUSY","Another export is running; retry later",5);
        quota=await consumeQuota(client);
        responseHeaders.set("X-Export-Site-Remaining",String(quota.siteRemaining));
        responseHeaders.set("X-Export-Reset",quota.resetAt);
        const deadline=()=>{if(Date.now()-started>30_000||request.signal.aborted)throw new ExportError(503,"EXPORT_TIMEOUT","Export timed out or caller disconnected; retry later")};
        deadline();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL statement_timeout='15s'");
        const now=new Date();
        const rows=await readExportWaves(client,range,now);
        await client.query("COMMIT");
        deadline();count=rows.length;
        if(Buffer.byteLength(JSON.stringify(rows))>EXPORT_LIMITS.bytes||rows.some(row=>Object.values(row).some(value=>typeof value==="string"&&value.length>32767)||row.helpers.join("、").length>32767))throw new ExportError(422,"FILE_TOO_LARGE","Export data is too large; shorten text fields");
        const metadata=exportMetadata(range,now.toISOString(),count);
        const output=await buildWaveWorkbook(rows,metadata,deadline);
        deadline();
        if(output.byteLength>EXPORT_LIMITS.bytes)throw new ExportError(422,"FILE_TOO_LARGE","Maximum file size is 20 MiB");
        responseHeaders.set("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        responseHeaders.set("Content-Disposition",`attachment; filename="waves-${range.date}.xlsx"; filename*=UTF-8''${encodeURIComponent(`波次数据-${range.date}.xlsx`)}`);
        status=200;return new Response(new Uint8Array(output),{headers:responseHeaders});
      }finally{
        // Destroy this dedicated connection on cleanup failure rather than pool a held lock.
        let broken=false;
        try{await client.query("ROLLBACK");if(locked)await client.query("SELECT pg_advisory_unlock(741203,2)")}catch{broken=true}
        client.release(broken);
      }
    }finally{active=false}
  }catch(error){
    const failure=error instanceof ExportError?error:new ExportError(503,"EXPORT_UNAVAILABLE","Export service unavailable; retry later");
    quota??=failure.quota;
    if(quota){responseHeaders.set("X-Export-Site-Remaining",String(quota.siteRemaining));responseHeaders.set("X-Export-Reset",quota.resetAt)}
    status=failure.status;
    if(failure.retryAfter)responseHeaders.set("Retry-After",String(failure.retryAfter));
    return Response.json({ok:false,requestId,error:{code:failure.code,message:failure.message},...(quota?{quota}:{})},{status,headers:responseHeaders});
  }finally{
    console.info(JSON.stringify({event:"wave_export",requestId,date:range?.date,count,status,durationMs:Date.now()-started}));
  }
}

// Prevent Next's implicit HEAD handler from generating a charged export.
export function HEAD(){return new Response(null,{status:405,headers:{...headers,Allow:"GET"}})}
export function OPTIONS(){return new Response(null,{status:405,headers:{...headers,Allow:"GET"}})}
