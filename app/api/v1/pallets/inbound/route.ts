import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { locations, movements, pallets, skus } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { createPalletId, getLocationSlotUsage, refreshLocationStatus } from "../../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

type InboundItem={
  sku?:string;
  remarks?:string;
  // Legacy fields are accepted and folded into remarks for older API clients.
  name?:string;
  initialQuantity?:number|null;
  quantity?:number|null;
  unit?:string;
  toLocationCode?:string;
};

export async function POST(request:NextRequest) {
  const user=await getInternalUser();
  if(!user) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const body=await request.json().catch(()=>({})) as {items?:InboundItem[]};
  if(!body.items?.length) return NextResponse.json({error:{message:"请至少添加一条备货信息"}},{status:400});

  const normalized=body.items.map(item=>({
    sku:item.sku?.trim().toUpperCase()??"",
    remarks:[
      item.remarks?.trim(),
      item.name?.trim()?`商品名称：${item.name.trim()}`:"",
      Number(item.initialQuantity??item.quantity)>0?`初始数量：${Number(item.initialQuantity??item.quantity)} ${item.unit?.trim()||"箱"}`:"",
    ].filter(Boolean).join("；"),
    unit:item.unit?.trim()||"箱",
    target:item.toLocationCode?.trim().toUpperCase()??"",
  }));
  if(normalized.some(item=>!item.sku||!item.target)) {
    return NextResponse.json({error:{message:"SKU 和备货库位为必填项"}},{status:400});
  }
  const targetCodes=normalized.map(item=>item.target);

  const db=getDb();
  const uniqueTargetCodes=Array.from(new Set(targetCodes));
  const targetRows=await db.select().from(locations).where(and(eq(locations.type,"reserve"),inArray(locations.code,uniqueTargetCodes)));
  const targetByCode=new Map(targetRows.map(location=>[location.code,location]));
  const invalidTarget=uniqueTargetCodes.find(code=>{
    const target=targetByCode.get(code);
    return !target;
  });
  if(invalidTarget) return NextResponse.json({error:{message:`备货库位 ${invalidTarget} 无效`}},{status:400});
  const requestedByTarget=new Map<string,number>();
  for(const code of targetCodes) requestedByTarget.set(code,(requestedByTarget.get(code)??0)+1);
  for(const [code,requested] of requestedByTarget) {
    const target=targetByCode.get(code)!;
    const usage=await getLocationSlotUsage(target.id);
    if(!usage||usage.availableSlots<requested) {
      return NextResponse.json({error:{message:`备货库位 ${code} 剩余容量不足（可用 ${usage?.availableSlots??0} 托）`}},{status:409});
    }
  }

  const skuCodes=Array.from(new Set(normalized.map(item=>item.sku)));
  const existingSkus=await db.select().from(skus).where(inArray(skus.code,skuCodes));
  const skuByCode=new Map(existingSkus.map(sku=>[sku.code,sku]));
  for(const code of skuCodes) {
    if(skuByCode.has(code)) continue;
    const item=normalized.find(row=>row.sku===code)!;
    const [created]=await db.insert(skus).values({code,unit:item.unit,createdAt:new Date().toISOString()}).returning();
    skuByCode.set(code,created);
  }

  const now=new Date();
  const inboundAt=now.toISOString();
  const usedIds=new Set<string>();
  const records:Array<{palletId:string;skuId:number;sku:string;locationId:number;location:string;remarks:string}>=[];
  for(let index=0;index<normalized.length;index++) {
    const item=normalized[index],target=targetByCode.get(item.target)!,sku=skuByCode.get(item.sku)!;
    let sequence=(now.getUTCMilliseconds()+index)%9999+1;
    let palletId=createPalletId(sequence,now);
    while(usedIds.has(palletId)||(await db.select({id:pallets.id}).from(pallets).where(eq(pallets.id,palletId)).limit(1)).length) {
      sequence=sequence%9999+1;
      palletId=createPalletId(sequence,now);
    }
    usedIds.add(palletId);
    records.push({palletId,skuId:sku.id,sku:item.sku,locationId:target.id,location:item.target,remarks:item.remarks});
  }

  await db.transaction(async tx=>{
    await tx.insert(pallets).values(records.map(record=>({
      id:record.palletId,skuId:record.skuId,locationId:record.locationId,remarks:record.remarks,
      status:"in_stock" as const,inboundAt,updatedAt:inboundAt,
    })));
    await tx.insert(movements).values(records.map(record=>({
      palletId:record.palletId,skuId:record.skuId,taskId:null,action:"inbound" as const,
      fromLocationId:null,toLocationId:record.locationId,quantity:0,occurredAt:inboundAt,operatorId:user.id,
    })));
  });
  for(const locationId of new Set(records.map(record=>record.locationId))) await refreshLocationStatus(locationId);
  await recordWarehouseRevision();

  return NextResponse.json({data:{
    count:records.length,
    items:records.map(record=>({...record,inboundAt})),
  }},{status:201});
}
