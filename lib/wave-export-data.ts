import type { PoolClient } from "pg";
import { ExportError,EXPORT_LIMITS,type ExportQuery } from "./wave-export-contract";
import { workDate } from "./timekeeping/time";

export type ExportWave={channel:string;type:string;waveNo:string;status:string;statusLabel:string;skuCount:number;orderCount:number;pieceCount:number;lead:string|null;helpers:string[];createdAt:string;startedAt:string|null;completedAt:string|null;totalMs:number;hourlyPieces:number|null;recordStatus:string};
export const WAVE_EXPORT_LABELS={completed:"已完成",interrupted:"中断",working:"进行中",unstarted:"未开始",paused:"暂停"};
type Row={channel_name:string;channel_type:string;wave_no:string;status:string;interrupted_at:Date|null;created_at:Date;completed_at:Date|null;sku_count:number;order_count:number;piece_count:number;started_at:Date|null;total_ms:string;active_count:string;lead:string|null;helpers:string[]};

export async function readExportWaves(client:PoolClient,query:ExportQuery,now:Date):Promise<ExportWave[]> {
  const result=await client.query<Row>(`WITH effective AS NOT MATERIALIZED (
    SELECT ws.work_item_id,ws.employee_id,ws.started_at,
      GREATEST(ws.started_at,sh.clock_in) AS begin,
      LEAST(COALESCE(ws.ended_at,$3::timestamptz),COALESCE(sh.clock_out,
        CASE WHEN sh.work_date < $4 THEN GREATEST(sh.clock_in,LEAST(
          ((sh.work_date::date+1)::timestamp AT TIME ZONE 'America/New_York')-interval '1 millisecond',
          sh.clock_in+interval '16 hours',$3::timestamptz)) ELSE $3::timestamptz END),$3::timestamptz) AS finish,
      ws.ended_at IS NULL AND sh.clock_out IS NULL AND sh.work_date=$4 AS active
    FROM time_work_sessions ws JOIN time_shifts sh ON sh.id=ws.shift_id
  ), selected AS (
    SELECT wi.* FROM time_work_items wi WHERE wi.work_type='wave' AND wi.created_at >= $1 AND wi.created_at < $2
    ORDER BY wi.sort_order,wi.id LIMIT ${EXPORT_LIMITS.rows+1}
  )
  SELECT wi.channel_name,wi.channel_type,COALESCE(wi.wave_no,wi.code) AS wave_no,wi.status,wi.interrupted_at,
    wi.created_at,wi.completed_at,wi.sku_count,wi.order_count,wi.piece_count,
    totals.started_at,COALESCE(totals.total_ms,0) AS total_ms,COALESCE(totals.active_count,0) AS active_count,
    people.lead,COALESCE(people.helpers,'{}') AS helpers
  FROM selected wi
  LEFT JOIN LATERAL (SELECT MIN(s.started_at) AS started_at,
    SUM(GREATEST(0,EXTRACT(EPOCH FROM(s.finish-s.begin))*1000)) AS total_ms,
    COUNT(*) FILTER(WHERE s.active) AS active_count FROM effective s WHERE s.work_item_id=wi.id) totals ON true
  LEFT JOIN LATERAL (SELECT MIN(e.name) FILTER(WHERE a.role='lead') AS lead,
    array_agg(e.name ORDER BY e.name,e.id) FILTER(WHERE a.role='helper') AS helpers
    FROM time_wave_assignments a JOIN time_employees e ON e.id=a.employee_id WHERE a.work_item_id=wi.id) people ON true
  ORDER BY wi.sort_order,wi.id`,[query.start,query.end,now,workDate(now)]);
  if(result.rows.length>EXPORT_LIMITS.rows)throw new ExportError(422,"TOO_MANY_ROWS","Maximum 20000 waves per export");
  return result.rows.map(row=>{
    const status=row.status==="completed"?"completed":row.interrupted_at?"interrupted":Number(row.active_count)>0?"working":row.started_at?"paused":"unstarted";
    const totalMs=Math.round(Number(row.total_ms));
    return {channel:row.channel_name.trim()||"其他",type:row.channel_type||"未标注",waveNo:row.wave_no,status,statusLabel:WAVE_EXPORT_LABELS[status],skuCount:row.sku_count,orderCount:row.order_count,pieceCount:row.piece_count,lead:row.lead,helpers:row.helpers,createdAt:row.created_at.toISOString(),startedAt:row.started_at?.toISOString()??null,completedAt:row.completed_at?.toISOString()??null,totalMs,hourlyPieces:totalMs>0?Math.round(row.piece_count*3_600_000/totalMs):null,recordStatus:row.status==="active"?"当前":"已完成"};
  });
}
