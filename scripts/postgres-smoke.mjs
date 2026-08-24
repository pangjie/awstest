import assert from "node:assert/strict";

const baseUrl=process.env.SMOKE_BASE_URL??"http://127.0.0.1:3100";
const username=process.env.SMOKE_ADMIN_USERNAME??"smoke-admin";
const password=process.env.SMOKE_ADMIN_PASSWORD;
if(!password)throw new Error("SMOKE_ADMIN_PASSWORD is required");

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

await request("/health/live",{authenticated:false});
await request("/health/ready",{authenticated:false});
await request("/api/v1/bootstrap",{authenticated:false,expected:401});

const login=await request("/api/auth/login",{
  method:"POST",authenticated:false,body:{username,password},
});
assert.equal(login.payload.data.role,"admin");
assert.match(cookie,/^neiku_session=/);

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
  body:{username:`operator-${suffix.toLowerCase()}`,name:"端到端测试员",password:"smoke-user-password",role:"operator"},
});
assert.equal(createdUser.payload.data.role,"operator");

const bootstrap=await request("/api/v1/bootstrap");
assert.ok(bootstrap.payload.data.locations.some(location=>location.code===reserveB));
assert.ok(bootstrap.payload.data.pallets.some(pallet=>pallet.id===movePallet&&pallet.location===reserveB));
assert.ok(bootstrap.payload.data.pallets.some(pallet=>pallet.id===pickPallet&&pallet.location===reserveA));
assert.ok(bootstrap.payload.data.movements.some(movement=>movement.action==="move"));
assert.ok(bootstrap.payload.data.movements.some(movement=>movement.action==="return"));

const movements=await request(`/api/v1/pallets/${encodeURIComponent(movePallet)}/movements`);
assert.ok(movements.payload.data.some(movement=>movement.action==="inbound"));
assert.ok(movements.payload.data.some(movement=>movement.action==="move"));
await request(`/api/v1/locations/${encodeURIComponent(reserveA)}/history?type=reserve`);
await request("/api/auth/logout",{method:"POST"});
await request("/api/v1/bootstrap",{expected:401});

console.log("PostgreSQL smoke flow passed: auth, location import, SKU merge, inbound, move, pick return, users and histories.");
