import assert from "node:assert/strict";
import {test} from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {exportLoader} from "./helpers/load-export-typescript.mjs";
const load=exportLoader();
const {parseExportQuery,quotaWindow}=load("lib/wave-export-contract.ts");
const query=(extra="")=>parseExportQuery(new URLSearchParams(`date=2026-09-01${extra}`));

test("export dates are strict, bounded, inclusive and DST aware",()=>{
  assert.equal(query().date,"2026-09-01");
  for(const text of ["","date=2026-02-30","date=not-a-date","date=9999-12-31"])assert.throws(()=>parseExportQuery(new URLSearchParams(text)));
  for(const extra of ["&format=csv","&dateBasis=nope","&token=secret","&date=2026-09-02"])assert.throws(()=>query(extra));
  for(const [day,hours] of [["2026-03-08",23],["2026-11-01",25]]){
    const range=parseExportQuery(new URLSearchParams({date:day}));
    assert.equal((Date.parse(range.end)-Date.parse(range.start))/3600000,hours);
    assert.equal(quotaWindow(new Date(range.start)).retryAfter,hours*3600);
  }
});

test("Excel preserves codes, numeric durations over 24h and literal formula-like names",async()=>{
  const {buildWaveWorkbook,exportMetadata}=load("lib/wave-export-workbook.ts");
  const row={channel:"USPS",type:"多件",waveNo:"000123",statusLabel:"已完成",skuCount:2,orderCount:3,pieceCount:100,lead:"=1+1",helpers:["员工甲"],startedAt:"2026-09-01T12:00:00Z",completedAt:null,totalMs:100*3600000,hourlyPieces:1,recordStatus:"已完成"};
  const bytes=await buildWaveWorkbook([row],exportMetadata(query(),"2026-10-01T00:00:00Z",1));
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  const sheet=book.getWorksheet("波次数据");
  assert.equal(sheet.getCell("H1").value,"姓名");
  assert.equal(sheet.getCell("L1").value,"用时");
  assert.equal(sheet.getCell("C2").value,"000123");assert.equal(sheet.getCell("H2").value,"=1+1");
  assert.equal(sheet.getCell("L2").numFmt,"[h]:mm:ss");
  const xml=await (await JSZip.loadAsync(bytes)).file("xl/worksheets/sheet1.xml").async("string");
  assert.match(xml,/<c r="L2"[^>]*><v>4\.166666666666667<\/v><\/c>/);
  assert.equal(sheet.getCell("M2").value,1);assert.equal(sheet.views[0].ySplit,1);
  assert.equal(sheet.getCell("J2").value,"2026-09-01T12:00:00Z");
  assert.ok(!sheet.getCell("K2").value);
  const empty=new ExcelJS.Workbook();await empty.xlsx.load(await buildWaveWorkbook([],exportMetadata(query(),new Date().toISOString(),0)));
  assert.equal(empty.getWorksheet("波次数据").rowCount,1);
});

test("export timestamps normalize summer and winter offsets to UTC Z and preserve blank times",async()=>{
  const {buildWaveWorkbook,exportMetadata}=load("lib/wave-export-workbook.ts");
  const row={channel:"USPS",type:"单件",waveNo:"test",statusLabel:"已完成",skuCount:1,orderCount:1,pieceCount:1,lead:null,helpers:[],startedAt:"2026-07-01T23:30:00.123-04:00",completedAt:"2026-12-01T23:30:00-05:00",totalMs:0,hourlyPieces:null,recordStatus:"已完成"};
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(await buildWaveWorkbook([row,{...row,startedAt:null,completedAt:null}],exportMetadata(query(),new Date().toISOString(),2)));
  const sheet=book.getWorksheet("波次数据");
  assert.equal(sheet.getCell("J2").value,"2026-07-02T03:30:00Z");
  assert.equal(sheet.getCell("K2").value,"2026-12-02T04:30:00Z");
  assert.ok(!sheet.getCell("J3").value);assert.ok(!sheet.getCell("K3").value);
});

test("Malformed dates are rejected without DB access; HEAD does not consume a quota",async()=>{
  const route=exportLoader({"@/db":{getPool(){throw new Error("must not connect")}},"../db":{getPool(){throw new Error("must not connect")}}})("app/api/v1/exports/waves/route.ts");
  const response=await route.GET(new Request("http://localhost/api/v1/exports/waves?startDate=2026-09-01&endDate=2026-09-30"));
  assert.equal(response.status,400);assert.match(response.headers.get("cache-control"),/no-store/);
  assert.equal(route.HEAD().status,405);
});

test("interrupted Excel generation closes its writer and rejects instead of returning a partial file",async()=>{
  const {buildWaveWorkbook,exportMetadata}=load("lib/wave-export-workbook.ts");
  await assert.rejects(()=>buildWaveWorkbook([{}],exportMetadata(query(),new Date().toISOString(),1),()=>{throw new Error("deadline")}),/deadline/);
});
