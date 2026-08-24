import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { locations, movements, pallets, skus } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { createPalletId, getLocationSlotUsage, lockWarehouseInventory, refreshLocationStatus } from "../../../../../lib/warehouse-data";
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
  const result=await db.transaction(async tx=>{
    await lockWarehouseInventory(tx);
    const uniqueTargetCodes=Array.from(new Set(targetCodes));
    const targetRows=await tx.select().from(locations).where(and(eq(locations.type,"reserve"),inArray(locations.code,uniqueTargetCodes)));
    const targetByCode=new Map(targetRows.map(location=>[location.code,location]));
    const invalidTarget=uniqueTargetCodes.find(code=>!targetByCode.has(code));
    if(invalidTarget)return {error:`备货库位 ${invalidTarget} 无效`,status:400 as const};

    const requestedByTarget=new Map<string,number>();
    for(const code of targetCodes)requestedByTarget.set(code,(requestedByTarget.get(code)??0)+1);
    for(const [code,requested] of requestedByTarget) {
      const usage=await getLocationSlotUsage(targetByCode.get(code)!.id,tx);
      if(!usage||usage.availableSlots<requested) {
        return {error:`备货库位 ${code} 剩余容量不足（可用 ${usage?.availableSlots??0} 托）`,status:409 as const};
      }
    }

    const now=new Date(),inboundAt=now.toISOString();
    const skuCodes=Array.from(new Set(normalized.map(item=>item.sku)));
    for(const code of skuCodes) {
      const item=normalized.find(row=>row.sku===code)!;
      await tx.insert(skus).values({code,unit:item.unit,createdAt:inboundAt}).onConflictDoNothing({target:skus.code});
    }
    const skuRows=await tx.select().from(skus).where(inArray(skus.code,skuCodes));
    const skuByCode=new Map(skuRows.map(sku=>[sku.code,sku]));
    const usedIds=new Set<string>();
    const records:Array<{palletId:string;skuId:number;sku:string;locationId:number;location:string;remarks:string}>=[];
    for(let index=0;index<normalized.length;index++) {
      const item=normalized[index],target=targetByCode.get(item.target)!,sku=skuByCode.get(item.sku)!;
      let sequence=(now.getUTCMilliseconds()+index)%9999+1,palletId="";
      for(let attempts=0;attempts<9_999;attempts++,sequence=sequence%9999+1) {
        const candidate=createPalletId(sequence,now);
        if(!usedIds.has(candidate)&&!(await tx.select({id:pallets.id}).from(pallets).where(eq(pallets.id,candidate)).limit(1)).length) {
          palletId=candidate;break;
        }
      }
      if(!palletId)throw new Error("当天托盘编号已用尽");
      usedIds.add(palletId);
      records.push({palletId,skuId:sku.id,sku:item.sku,locationId:target.id,location:item.target,remarks:item.remarks});
    }

    await tx.insert(pallets).values(records.map(record=>({
      id:record.palletId,skuId:record.skuId,locationId:record.locationId,remarks:record.remarks,
      status:"in_stock" as const,inboundAt,updatedAt:inboundAt,
    })));
    await tx.insert(movements).values(records.map(record=>({
      palletId:record.palletId,skuId:record.skuId,taskId:null,action:"inbound" as const,
      fromLocationId:null,toLocationId:record.locationId,quantity:0,remarks:record.remarks,occurredAt:inboundAt,operatorId:user.id,
    })));
    for(const locationId of new Set(records.map(record=>record.locationId)))await refreshLocationStatus(locationId,tx);
    await recordWarehouseRevision(tx);
    return {data:{count:records.length,items:records.map(record=>({...record,inboundAt}))}};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result,{status:201});
}
