import type { PoolClient } from "pg";
import { getPool } from "../db";
import { ExportError,EXPORT_LIMITS,quotaWindow } from "./wave-export-contract";
import { workDate } from "./timekeeping/time";

let initializing:Promise<void>|undefined;
export function ensureExportQuotaSchema(){
  initializing??=(async()=>{
    const client=await getPool().connect();
    try{
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock(741203,1)");
      await client.query(`CREATE TABLE IF NOT EXISTS wave_export_daily_quotas (
        work_date TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0 CHECK (used>=0),
        recent_requests TIMESTAMPTZ[] NOT NULL DEFAULT '{}'
      )`);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  })().catch(error=>{initializing=undefined;throw error});
  return initializing;
}

// The caller holds the site-wide export lock until file generation has finished.
// Counters commit before the business query: errors/disconnects do not refund work.
export async function consumeQuota(client:PoolClient){
  await client.query("BEGIN");
  try{
    await client.query("SET LOCAL statement_timeout='5s'");
    const now=new Date((await client.query("SELECT clock_timestamp() AS now")).rows[0].now);
    const window=quotaWindow(now);
    await client.query("INSERT INTO wave_export_daily_quotas(work_date) VALUES($1) ON CONFLICT DO NOTHING",[window.day]);
    const result=await client.query<{used:number}>("SELECT used FROM wave_export_daily_quotas WHERE work_date=$1 FOR UPDATE",[window.day]);
    const site=result.rows[0];
    if(site.used>=EXPORT_LIMITS.siteDaily){
      const error=new ExportError(429,"DAILY_LIMIT","Daily export quota exhausted",window.retryAfter);
      error.quota={siteRemaining:Math.max(0,EXPORT_LIMITS.siteDaily-site.used),resetAt:window.reset};
      throw error;
    }
    // Read the preceding day's last minute too, so midnight cannot double the burst allowance.
    const recent=(await client.query<{at:Date}>("SELECT at FROM wave_export_daily_quotas q CROSS JOIN LATERAL unnest(q.recent_requests) at WHERE at>$1::timestamptz-interval '60 seconds' ORDER BY at",[now])).rows.map(row=>new Date(row.at));
    if(recent.length>=EXPORT_LIMITS.minute)throw new ExportError(429,"RATE_LIMIT","Maximum 6 accepted requests per rolling minute",Math.max(1,Math.ceil((recent[0].getTime()+60_000-now.getTime())/1000)));
    await client.query("UPDATE wave_export_daily_quotas SET used=used+1,recent_requests=$2::timestamptz[] WHERE work_date=$1",[window.day,[...recent.filter(at=>workDate(at)===window.day),now]]);
    await client.query("DELETE FROM wave_export_daily_quotas WHERE work_date<$1",[new Date(now.getTime()-90*86400000).toISOString().slice(0,10)]);
    await client.query("COMMIT");
    return {siteRemaining:EXPORT_LIMITS.siteDaily-site.used-1,resetAt:window.reset};
  }catch(error){await client.query("ROLLBACK");throw error}
}
