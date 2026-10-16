import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {exportLoader} from "./helpers/load-export-typescript.mjs";

test("statistics paginates a consistent read-only history and enforces its own permission",{skip:process.env.RUN_STATISTICS_PG_TESTS!=="1"},async()=>{
  const url=new URL(process.env.DATABASE_URL);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname));
  const schema=`test_statistics_${randomBytes(8).toString("hex")}`;
  const admin=new pg.Pool({connectionString:url.toString()});
  const pool=new pg.Pool({connectionString:url.toString(),options:`-c search_path=${schema}`});
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE time_revisions(id integer);INSERT INTO time_revisions VALUES(1);
      CREATE TABLE time_employees(id integer,name text,organization_type text,active boolean);
      CREATE TABLE time_shifts(id integer,employee_id integer,work_date text,clock_in timestamptz,clock_out timestamptz);
      CREATE TABLE time_work_sessions(id integer,employee_id integer,shift_id integer,work_item_id integer,started_at timestamptz,ended_at timestamptz);
      CREATE TABLE time_attendance_edits(shift_id integer);CREATE TABLE time_work_session_edits(session_id integer);
      CREATE TABLE time_work_items(id integer,name text,code text,work_type text,wave_no text,channel_name text,channel_type text,status text,created_at timestamptz,completed_at timestamptz,order_count integer,piece_count integer);
      INSERT INTO time_employees VALUES(1,'Historical employee','OZM',false);
      INSERT INTO time_work_items VALUES(1,'Warehouse','WAREHOUSE','standard',NULL,'','','active','2026-08-01Z',NULL,0,0);
      INSERT INTO time_shifts VALUES(1,1,'2026-09-01','2026-09-01T12:00Z','2026-09-01T16:00Z'),(2,1,'2026-09-08','2026-09-08T12:00Z',NULL);
      INSERT INTO time_work_sessions VALUES(1,1,1,1,'2026-09-01T13:00Z','2026-09-01T15:00Z'),(2,1,2,1,'2026-09-08T13:00Z',NULL);
      INSERT INTO time_attendance_edits VALUES(1);INSERT INTO time_work_session_edits VALUES(1);`);
    let permitted=true;
    const route=exportLoader({"@/db":{getPool:()=>pool},"@/lib/internal-auth":{authorizePageAccess:async key=>{assert.equal(key,"time-statistics");return permitted?{authorized:true}:{authorized:false,status:403,message:"denied"}}}})("app/api/v1/timekeeping/statistics/route.ts");
    const request=(query="")=>({nextUrl:new URL(`http://localhost/api/v1/timekeeping/statistics?startDate=2026-09-01&endDate=2026-09-08${query}`)});
    const response=await route.GET(request());assert.equal(response.status,200);assert.match(response.headers.get("cache-control"),/no-store/);
    const page=await response.json();assert.equal(page.next,"2026-09-08");assert.equal(page.shifts.length,1);assert.equal(page.sessions[0].modified,true);assert.equal(page.shifts[0].modified,true);assert.equal(page.employees[0].active,false);
    const end=await route.GET(request(`&cursor=${page.next}&revision=${page.revision}&snapshotAt=${encodeURIComponent(page.snapshotAt)}`));const last=await end.json();assert.equal(last.snapshotAt,page.snapshotAt);assert.equal(last.next,null);assert.equal(last.sessions[0].end,null);assert.equal(last.employees.length,0);
    assert.equal((await pool.query("SELECT clock_out FROM time_shifts WHERE id=2")).rows[0].clock_out,null,"reading must not close an old shift");
    await pool.query("INSERT INTO time_revisions VALUES(2)");
    assert.equal((await route.GET(request(`&cursor=${page.next}&revision=${page.revision}&snapshotAt=${encodeURIComponent(page.snapshotAt)}`))).status,409);
    assert.equal((await route.GET(request("&cursor=2026-08-01"))).status,400);
    assert.equal((await route.GET(request(`&cursor=${page.next}&revision=${page.revision}`))).status,400);
    assert.equal((await route.GET(request("&snapshotAt=invalid"))).status,400);
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const live=await route.GET({nextUrl:new URL(`http://localhost/api/v1/timekeeping/statistics?startDate=${today}&endDate=${today}`)});
    assert.equal(live.status,200);assert.ok(Number.isFinite(Date.parse((await live.json()).snapshotAt)));
    permitted=false;assert.equal((await route.GET(request())).status,403);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
});
