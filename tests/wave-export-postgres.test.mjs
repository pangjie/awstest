import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import pg from "pg";
import ExcelJS from "exceljs";
import {exportLoader} from "./helpers/load-export-typescript.mjs";

test("wave export SQL, persistent quota and HTTP integration in an isolated local schema",{skip:process.env.RUN_WAVE_EXPORT_PG_TESTS!=="1"},async()=>{
  const url=new URL(process.env.DATABASE_URL);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname),"Only local PostgreSQL may be used");
  const schema=`test_wave_export_${randomBytes(8).toString("hex")}`;
  const admin=new pg.Pool({connectionString:url.toString()});
  const pool=new pg.Pool({connectionString:url.toString(),options:`-c search_path=${schema}`,max:4});
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE time_work_items(id integer primary key,code text,wave_no text,channel_name text,channel_type text,status text,interrupted_at timestamptz,created_at timestamptz,completed_at timestamptz,sku_count integer,order_count integer,piece_count integer,sort_order integer,work_type text);
      CREATE TABLE time_employees(id integer primary key,name text);
      CREATE TABLE time_shifts(id integer primary key,work_date text,clock_in timestamptz,clock_out timestamptz);
      CREATE TABLE time_work_sessions(id integer primary key,work_item_id integer,employee_id integer,shift_id integer,started_at timestamptz,ended_at timestamptz);
      CREATE TABLE time_wave_assignments(work_item_id integer,employee_id integer,role text);
      INSERT INTO time_employees VALUES(1,'=NAME'),(2,'Helper');
      INSERT INTO time_work_items VALUES(1,'W1','000123','USPS','多件','completed',NULL,'2026-09-30T12:00Z','2026-10-01T18:00Z',2,5,90,1,'wave'),(2,'W2','000124','CBT','单件','active',NULL,'2026-10-01T12:00Z',NULL,1,1,1,2,'wave');
      INSERT INTO time_shifts VALUES(1,'2026-09-30','2026-09-30T12:00Z','2026-09-30T13:00Z'),(2,'2026-09-30','2026-09-30T14:00Z','2026-09-30T15:00Z'),(3,'2026-10-01','2026-10-01T12:00Z','2026-10-01T13:00Z');
      INSERT INTO time_work_sessions VALUES(1,1,1,1,'2026-09-30T11:00Z','2026-09-30T13:30Z'),(2,1,1,2,'2026-09-30T14:00Z','2026-09-30T16:00Z'),(3,1,2,3,'2026-10-01T12:00Z',NULL);
      INSERT INTO time_wave_assignments VALUES(1,1,'lead'),(1,2,'helper');
    `);
    const load=exportLoader({"../db":{getPool:()=>pool},"@/db":{getPool:()=>pool}});
    const {parseExportQuery,quotaWindow}=load("lib/wave-export-contract.ts");
    const {readExportWaves}=load("lib/wave-export-data.ts");
    const params=(date="2026-09-30")=>parseExportQuery(new URLSearchParams({date}));
    const now=new Date("2026-10-02T12:00:00Z");
    const c=await pool.connect();
    try{
      await c.query("BEGIN READ ONLY");
      const rows=await readExportWaves(c,params(),now);
      assert.equal(rows.length,1);assert.equal(rows[0].totalMs,3*3600000);assert.equal(rows[0].hourlyPieces,30);
      assert.deepEqual(rows[0].helpers,["Helper"]);assert.equal(rows[0].lead,"=NAME");
      assert.equal((await readExportWaves(c,params("2026-10-01"),now))[0].waveNo,"000124");
      await c.query("COMMIT");
    }finally{c.release()}
    const {ensureExportQuotaSchema,consumeQuota}=load("lib/wave-export-quota.ts");
    await ensureExportQuotaSchema();
    const route=load("app/api/v1/exports/waves/route.ts");
    const request=()=>new Request("http://localhost/api/v1/exports/waves?date=2026-09-30");
    const first=await route.GET(request());assert.equal(first.status,200);
    const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await first.arrayBuffer()));
    const sheet=book.getWorksheet("波次数据");assert.equal(sheet.getCell("H2").value,"=NAME");assert.equal(sheet.getCell("I2").value,"Helper");assert.equal(sheet.getCell("M2").value,30);
    assert.equal(first.headers.get("x-export-site-remaining"),"99");
    const binary=await route.GET(request());assert.equal(binary.status,200);assert.match(binary.headers.get("content-type"),/spreadsheetml/);assert.equal(Buffer.from(await binary.arrayBuffer()).subarray(0,2).toString(),"PK");
    // A held lock rejects the request before spending its quota.
    const blocker=await pool.connect();
    try{await blocker.query("SELECT pg_advisory_lock(741203,2)");assert.equal((await route.GET(request())).status,429)}finally{await blocker.query("SELECT pg_advisory_unlock(741203,2)");blocker.release()}
    for(let i=0;i<4;i++)assert.equal((await route.GET(request())).status,200);
    const burst=await route.GET(request());assert.equal((await burst.json()).error.code,"RATE_LIMIT");
    const day=quotaWindow().day;
    await pool.query("UPDATE wave_export_daily_quotas SET used=99,recent_requests='{}' WHERE work_date=$1",[day]);
    const pair=await Promise.all([route.GET(request()),route.GET(request())]);
    assert.deepEqual(pair.map(r=>r.status).sort(),[200,429]);
    const exhausted=await route.GET(request());assert.equal((await exhausted.json()).error.code,"DAILY_LIMIT");assert.equal(exhausted.headers.get("x-export-site-remaining"),"0");
    // A new module/process does not reset database counters.
    const quotaReload=exportLoader({"../db":{getPool:()=>pool}})("lib/wave-export-quota.ts");
    const q=await pool.connect();try{await assert.rejects(()=>quotaReload.consumeQuota(q),{code:"DAILY_LIMIT"})}finally{q.release()}
    await pool.query("UPDATE wave_export_daily_quotas SET used=100 WHERE work_date=$1",[day]);
    const client=await pool.connect();try{await assert.rejects(()=>consumeQuota(client),{code:"DAILY_LIMIT"})}finally{client.release()}
    // Oversized results are rejected, not silently truncated.
    await pool.query("INSERT INTO time_work_items SELECT n,'W'||n,'W'||n,'USPS','单件','active',NULL,'2026-09-30T12:00Z'::timestamptz,NULL,1,1,1,n,'wave' FROM generate_series(3,20003) n");
    const large=await pool.connect();try{await assert.rejects(()=>readExportWaves(large,params(),now),{code:"TOO_MANY_ROWS"})}finally{large.release()}
  }finally{
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
