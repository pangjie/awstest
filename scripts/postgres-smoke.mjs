import assert from "node:assert/strict";

const baseUrl=process.env.SMOKE_BASE_URL??"http://127.0.0.1:3100";
const username=process.env.SMOKE_ADMIN_USERNAME??process.env.INITIAL_ADMIN_USERNAME??"smoke-admin";
const password=process.env.SMOKE_ADMIN_PASSWORD??process.env.INITIAL_ADMIN_PASSWORD;
if(!password)throw new Error("SMOKE_ADMIN_PASSWORD or INITIAL_ADMIN_PASSWORD is required");

let cookie="";

async function request(path,{method="GET",body,headers={},expected=200,authenticated=true}={}) {
  const response=await fetch(`${baseUrl}${path}`,{
    method,
    headers:{
      ...(body===undefined?{}:{"content-type":"application/json"}),
      ...(authenticated&&cookie?{cookie}:{}),
      ...headers,
    },
    body:body===undefined?undefined:JSON.stringify(body),
    redirect:"manual",
  });
  const setCookie=response.headers.get("set-cookie");
  if(setCookie)cookie=setCookie.split(";",1)[0];
  const contentType=response.headers.get("content-type")??"";
  const payload=contentType.includes("application/json")?await response.json():await response.arrayBuffer();
  assert.equal(response.status,expected,`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
  return {payload,response};
}

const suffix=Date.now().toString(36).toUpperCase();
const reserveA=`E2E-A-${suffix}`;
const reserveB=`E2E-B-${suffix}`;
const pick=`E2E-P-${suffix}`;
const skuOne=`E2E-SKU-1-${suffix}`;
const skuTwo=`E2E-SKU-2-${suffix}`;
const restrictedUsername=`operator-${suffix.toLowerCase()}`;
const restrictedPassword="smoke-user-password";

await request("/health/live",{authenticated:false});
await request("/health/ready",{authenticated:false});
await request("/api/v1/bootstrap",{authenticated:false,expected:401});

const login=await request("/api/auth/login",{
  method:"POST",authenticated:false,body:{username,password},
});
assert.equal(login.payload.data.role,"admin");
assert.match(cookie,/^neiku_session=/);

const initialTimeEmployees=await request("/api/v1/timekeeping/employees");
assert.equal(initialTimeEmployees.payload.ok,true);
const timeEmployeeName=`E2E工时-${suffix}`;
const createdTimeEmployee=await request("/api/v1/timekeeping/employees",{
  method:"POST",expected:201,body:{name:timeEmployeeName,type:"OZM"},
});
const timeBadge=createdTimeEmployee.payload.employees[0].badgeCode;
assert.match(timeBadge,/^[34679CFHKMNRVWXY]{8}$/);
const timeWaveNo=`W-E2E-${suffix}`;
await request("/api/v1/timekeeping/waves",{
  method:"POST",expected:201,body:{items:[{waveNo:timeWaveNo,channelName:"E2E渠道",channelType:"多件",skuCount:3,orderCount:5,pieceCount:8}]},
});
const timeWorkItems=await request("/api/v1/timekeeping/waves");
assert.equal(timeWorkItems.payload.standardTasks.length,5);
const timeWave=timeWorkItems.payload.currentWaves.find(item=>item.waveNo===timeWaveNo);
assert.ok(timeWave);
const scanId=label=>`e2e-${suffix}-${label}`;
const identified=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:timeBadge,requestId:scanId("identify"),terminalId:"e2e"}});
assert.equal(identified.payload.event,"CLOCK_IN_PENDING");
const clockedIn=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:"ACT-CLOCKIN",employeeId:identified.payload.employeeId,requestId:scanId("in"),terminalId:"e2e"}});
assert.equal(clockedIn.payload.event,"CLOCK_IN");
const fixedWork=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:"JOB-SCAN",employeeId:identified.payload.employeeId,requestId:scanId("fixed"),terminalId:"e2e"}});
assert.equal(fixedWork.payload.event,"PROJECT_START");
const waveWork=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:timeWaveNo,employeeId:identified.payload.employeeId,requestId:scanId("wave"),terminalId:"e2e"}});
assert.equal(waveWork.payload.snapshot.currentProject.assignmentRole,"lead");
const duplicateWave=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:timeWaveNo,employeeId:identified.payload.employeeId,requestId:scanId("wave"),terminalId:"e2e"}});
assert.equal(duplicateWave.payload.duplicate,true);
const completedWave=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:"ACT-WAVE-COMPLETE",employeeId:identified.payload.employeeId,completeProjectId:timeWave.id,requestId:scanId("complete"),terminalId:"e2e"}});
assert.equal(completedWave.payload.event,"WAVE_COMPLETE");
const clockedOut=await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:"ACT-OUT",employeeId:identified.payload.employeeId,requestId:scanId("out"),terminalId:"e2e"}});
assert.equal(clockedOut.payload.event,"CLOCK_OUT");
const timeDashboard=await request("/api/v1/timekeeping/dashboard");
assert.ok(timeDashboard.payload.attendance.some(item=>item.badgeCode===timeBadge));
const timeReport=await request(`/api/v1/timekeeping/records?badge=${timeBadge}`);
assert.equal(timeReport.payload.snapshot.employee.badgeCode,timeBadge);
assert.ok(timeReport.payload.projects.length>=2);
const timeRevision=await request("/api/v1/timekeeping/revision");
assert.ok(timeRevision.payload.revision>0);
await request("/api/v1/timekeeping/employees",{method:"PATCH",body:{id:identified.payload.employeeId,active:false}});

const importedLocations=await request("/api/v1/locations",{
  method:"POST",
  body:{action:"import",rows:[
    {code:reserveA,type:"reserve",capacity:2,sourceRow:2},
    {code:reserveB,type:"reserve",capacity:2,sourceRow:3},
    {code:pick,type:"pick",capacity:2,sourceRow:4},
  ]},
});
assert.equal(importedLocations.payload.data.createdRows,3);

await request("/api/v1/sku-catalog",{
  method:"POST",expected:201,
  body:{action:"create",code:skuOne,barcode:"111",client:"E2E",productName:"测试商品"},
});
await request("/api/v1/sku-catalog",{
  method:"POST",expected:409,
  body:{action:"create",code:skuOne},
});

const importStart=await request("/api/v1/sku-catalog",{method:"POST",body:{action:"start"}});
const {importKey,importedAt}=importStart.payload.data;
await request("/api/v1/sku-catalog",{
  method:"POST",
  body:{action:"batch",importKey,importedAt,rows:[
    {code:skuOne,barcode:"111-updated",client:"E2E",productName:"更新名称",sourceRow:2},
    {code:skuTwo,barcode:"222-old",client:"E2E",productName:"旧名称",sourceRow:3},
    {code:skuTwo,barcode:"222-final",client:"E2E",productName:"最终名称",sourceRow:4},
  ]},
});
const importFinish=await request("/api/v1/sku-catalog",{
  method:"POST",body:{action:"finish",importKey,importedAt},
});
assert.equal(importFinish.payload.data.addedCodes,1);
assert.equal(importFinish.payload.data.updatedCodes,1);
assert.equal(importFinish.payload.data.duplicateCodes,1);

const inbound=await request("/api/v1/pallets/inbound",{
  method:"POST",expected:201,
  body:{items:[
    {sku:skuOne,remarks:"迁移业务测试",toLocationCode:reserveA},
    {sku:skuTwo,remarks:"取货业务测试",toLocationCode:reserveA},
  ]},
});
assert.equal(inbound.payload.data.count,2);
const [movePallet,pickPallet]=inbound.payload.data.items.map(item=>item.palletId);

const moveTask=await request("/api/v1/tasks",{
  method:"POST",expected:201,
  body:{type:"move",moveItems:[{palletId:movePallet,toLocationCode:reserveB}]},
});
await request(`/api/v1/tasks/${encodeURIComponent(moveTask.payload.data.id)}/claim`,{method:"POST"});
await request(`/api/v1/tasks/${encodeURIComponent(moveTask.payload.data.id)}/complete`,{
  method:"POST",body:{outcome:"completed"},
});

const pickTask=await request("/api/v1/tasks",{
  method:"POST",expected:201,
  body:{type:"pick",pickItems:[{palletId:pickPallet,toLocationCode:pick,note:"逐托备注测试"}]},
});
await request("/api/v1/tasks",{
  method:"POST",expected:409,
  body:{type:"pick",pickItems:[{palletId:pickPallet,toLocationCode:pick}]},
});
const pickCompletion=await request(`/api/v1/tasks/${encodeURIComponent(pickTask.payload.data.id)}/complete`,{
  method:"POST",body:{outcome:"returned",palletId:pickPallet},
});
assert.equal(pickCompletion.payload.data.allConfirmed,true);
assert.equal(pickCompletion.payload.data.status,"returned");

const createdUser=await request("/api/v1/users",{
  method:"POST",expected:201,
  body:{username:restrictedUsername,password:restrictedPassword,pagePermissions:["reserve-inventory"]},
});
assert.equal(createdUser.payload.data.role,"operator");
assert.deepEqual(createdUser.payload.data.pagePermissions,["reserve-inventory"]);

const bootstrap=await request("/api/v1/bootstrap");
assert.ok(bootstrap.payload.data.locations.some(location=>location.code===reserveB));
assert.ok(bootstrap.payload.data.pallets.some(pallet=>pallet.id===movePallet&&pallet.location===reserveB));
assert.ok(bootstrap.payload.data.pallets.some(pallet=>pallet.id===pickPallet&&pallet.location===reserveA));
assert.ok(bootstrap.payload.data.movements.some(movement=>movement.action==="move"));
assert.ok(bootstrap.payload.data.movements.some(movement=>movement.action==="return"));

const movements=await request(`/api/v1/pallets/${encodeURIComponent(movePallet)}/movements`);
assert.ok(movements.payload.data.some(movement=>movement.action==="inbound"));
assert.ok(movements.payload.data.some(movement=>movement.action==="move"));

const importedPallet=`E2E-IMPORT-${suffix}`;
const importedInboundAt=new Date(Date.now()-3_600_000).toISOString();
const reserveImportRow={
  location:reserveB,slotIndex:2,slotCapacity:2,sku:skuOne,palletId:importedPallet,
  remarks:"备库总表导入测试",inboundAt:importedInboundAt,status:"in_stock",sourceRow:2,
};
const reserveImport=await request("/api/v1/pallets/import",{method:"POST",body:{rows:[reserveImportRow]}});
assert.deepEqual(reserveImport.payload.data,{importedRows:1,createdRows:1,updatedRows:0,skippedRows:0});
const reserveDuplicate=await request("/api/v1/pallets/import",{method:"POST",body:{rows:[reserveImportRow]}});
assert.deepEqual(reserveDuplicate.payload.data,{importedRows:1,createdRows:0,updatedRows:0,skippedRows:1});
const reserveUpdate=await request("/api/v1/pallets/import",{
  method:"POST",body:{rows:[{...reserveImportRow,location:reserveA,slotIndex:2,remarks:"备库总表更新测试"}]},
});
assert.deepEqual(reserveUpdate.payload.data,{importedRows:1,createdRows:0,updatedRows:1,skippedRows:0});

const ledgerSourceId=1;
const ledgerBase={
  occurredAt:new Date(Date.now()+60_000).toISOString(),action:"adjust",sku:skuOne,palletId:importedPallet,
  fromLocation:reserveA,fromLocationType:"reserve",toLocation:reserveA,toLocationType:"reserve",
  remarks:"台账导入测试",taskId:"",operatorUsername:username,operatorName:"",sourceRow:2,
};
const ledgerImport=await request("/api/v1/movements",{
  method:"POST",body:{action:"import",rows:[{...ledgerBase,sourceId:ledgerSourceId}]},
});
assert.deepEqual(ledgerImport.payload.data,{importedRows:1,createdRows:1,skippedRows:0});
const ledgerDuplicate=await request("/api/v1/movements",{
  method:"POST",body:{action:"import",rows:[{...ledgerBase,sourceId:ledgerSourceId}]},
});
assert.deepEqual(ledgerDuplicate.payload.data,{importedRows:1,createdRows:0,skippedRows:1});
const automaticOccurredAt=new Date(Date.now()+120_000).toISOString();
const automaticLedger=await request("/api/v1/movements",{
  method:"POST",body:{action:"import",rows:[{...ledgerBase,sourceId:null,occurredAt:automaticOccurredAt,sourceRow:3}]},
});
assert.deepEqual(automaticLedger.payload.data,{importedRows:1,createdRows:1,skippedRows:0});
const automaticLedgerDuplicate=await request("/api/v1/movements",{
  method:"POST",body:{action:"import",rows:[{...ledgerBase,sourceId:null,occurredAt:automaticOccurredAt,sourceRow:3}]},
});
assert.deepEqual(automaticLedgerDuplicate.payload.data,{importedRows:1,createdRows:0,skippedRows:1});
const ledgerAfterImport=await request(`/api/v1/movements?pallet=${encodeURIComponent(importedPallet)}&limit=1000`);
const importedLedgerRow=ledgerAfterImport.payload.data.find(row=>row.action==="adjust"&&row.sourceId===ledgerSourceId);
assert.ok(importedLedgerRow,"imported ledger rows must retain their source record ID");
assert.notEqual(importedLedgerRow.id,ledgerSourceId,"source IDs must not replace local movement IDs");
assert.equal(importedLedgerRow.remarks,"台账导入测试","ledger remarks must be stored as historical snapshots");

const distinctOccurredAt=new Date(Date.now()+180_000).toISOString();
const distinctLedgerRows=[
  {...ledgerBase,sourceId:100_001,occurredAt:distinctOccurredAt,remarks:"同刻记录 A",sourceRow:2},
  {...ledgerBase,sourceId:100_002,occurredAt:distinctOccurredAt,remarks:"同刻记录 B",operatorUsername:"legacy-user",operatorName:"历史操作人",sourceRow:3},
];
const distinctLedgerImport=await request("/api/v1/movements",{method:"POST",body:{action:"import",rows:distinctLedgerRows}});
assert.deepEqual(distinctLedgerImport.payload.data,{importedRows:2,createdRows:2,skippedRows:0});
const distinctLedger=await request(`/api/v1/movements?pallet=${encodeURIComponent(importedPallet)}&limit=1000`);
assert.ok(distinctLedger.payload.data.some(row=>row.sourceId===100_001&&row.remarks==="同刻记录 A"));
assert.ok(distinctLedger.payload.data.some(row=>row.sourceId===100_002&&row.remarks==="同刻记录 B"&&row.operatorUsername==="legacy-user"));

const historicalPallet=`E2E-HISTORY-${suffix}`;
const historicalTask=`SOURCE-TASK-${suffix}`;
const historicalInboundAt=new Date(Date.now()-7_200_000).toISOString();
const historicalPickAt=new Date(Date.now()-3_600_000).toISOString();
const historicalRows=[
  {...ledgerBase,sourceId:2,occurredAt:historicalInboundAt,action:"inbound",palletId:historicalPallet,
    fromLocation:"",fromLocationType:null,toLocation:reserveA,toLocationType:"reserve",taskId:"",
    operatorUsername:"legacy-user",operatorName:"历史操作人",sourceRow:2},
  {...ledgerBase,sourceId:3,occurredAt:historicalPickAt,action:"pick",palletId:historicalPallet,
    fromLocation:reserveA,fromLocationType:"reserve",toLocation:pick,toLocationType:"pick",taskId:historicalTask,
    operatorUsername:"legacy-user",operatorName:"历史操作人",sourceRow:3},
];
const historicalImport=await request("/api/v1/movements",{method:"POST",body:{action:"import",rows:historicalRows}});
assert.deepEqual(historicalImport.payload.data,{importedRows:2,createdRows:2,skippedRows:0});
const historicalDuplicate=await request("/api/v1/movements",{method:"POST",body:{action:"import",rows:historicalRows}});
assert.deepEqual(historicalDuplicate.payload.data,{importedRows:2,createdRows:0,skippedRows:2});
const historicalLedger=await request(`/api/v1/movements?pallet=${encodeURIComponent(historicalPallet)}&limit=1000`);
assert.equal(historicalLedger.payload.data.length,2);
assert.ok(historicalLedger.payload.data.some(row=>row.taskId===historicalTask&&row.operatorUsername==="legacy-user"&&row.operator==="历史操作人"));
const bootstrapAfterHistory=await request("/api/v1/bootstrap");
assert.ok(!bootstrapAfterHistory.payload.data.pallets.some(pallet=>pallet.id===historicalPallet),"depleted historical pallets must not become current inventory");

const unsafeHistorical=await request("/api/v1/movements",{
  method:"POST",expected:400,
  body:{action:"import",rows:[{...historicalRows[0],sourceId:4,palletId:`E2E-ACTIVE-${suffix}`,sourceRow:2}]},
});
assert.match(unsafeHistorical.payload.error.message,/最新状态不是“全部取出”/);

await request(`/api/v1/locations/${encodeURIComponent(reserveA)}/history?type=reserve`);
await request("/api/auth/logout",{method:"POST"});
await request("/api/auth/login",{
  method:"POST",authenticated:false,body:{username:restrictedUsername,password:restrictedPassword},
});
const restrictedBootstrap=await request("/api/v1/bootstrap");
assert.deepEqual(restrictedBootstrap.payload.data.currentUser.pagePermissions,["reserve-inventory"]);
assert.equal(restrictedBootstrap.payload.data.users.length,0);
assert.ok(restrictedBootstrap.payload.data.pallets.length>0);
await request("/api/v1/pallets");
await request("/api/v1/sku-catalog",{expected:403});
await request("/api/v1/tasks?detail=1",{expected:403});
await request("/api/v1/users",{expected:403});
await request("/api/v1/timekeeping/scan",{method:"POST",body:{code:"ACT-CLOCKIN"},expected:403});
await request("/api/v1/timekeeping/dashboard",{expected:403});
await request("/api/v1/timekeeping/records?badge=3467",{expected:403});
await request("/api/v1/timekeeping/employees",{expected:403});
await request("/api/v1/timekeeping/waves",{expected:403});
await request("/api/auth/logout",{method:"POST"});
await request("/api/v1/bootstrap",{expected:401});

console.log("PostgreSQL smoke flow passed: auth, page permissions, timekeeping scan/employee/wave/report/dashboard, location/SKU/reserve/cross-system ledger imports, inbound, move, pick return, users and histories.");
