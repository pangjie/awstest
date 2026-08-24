import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { movements, pallets, skus } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { getLocationByCode, getLocationSlotUsage, lockWarehouseInventory, refreshLocationStatus } from "../../../../../lib/warehouse-data";
import { warehouseDateTimeInputToIso } from "../../../../../lib/warehouse-time";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function PATCH(request:NextRequest,{params}:{params:Promise<{palletId:string}>}) {
  const user=await getInternalUser();
  if(!user) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const palletId=decodeURIComponent((await params).palletId);
  const body=await request.json().catch(()=>({})) as {sku?:string;remarks?:string;name?:string;quantity?:number;initialQuantity?:number;unit?:string;locationCode?:string;inboundAt?:string};
  const skuCode=body.sku?.trim().toUpperCase();
  if(!skuCode) return NextResponse.json({error:{message:"SKU 为必填项"}},{status:400});
  let requestedInboundAt:string|undefined;
  if(body.inboundAt) {
    try{requestedInboundAt=warehouseDateTimeInputToIso(body.inboundAt)}
    catch{return NextResponse.json({error:{message:"入库时间无效，请按美东时间填写"}},{status:400})}
  }
  const targetCode=body.locationCode?.trim().toUpperCase();
  if(!targetCode) return NextResponse.json({error:{message:"备货库位为必填项"}},{status:400});
  const legacyQuantity=Number(body.initialQuantity??body.quantity);
  const result=await getDb().transaction(async tx=>{
    await lockWarehouseInventory(tx);
    const current=(await tx.select().from(pallets).where(eq(pallets.id,palletId)).limit(1))[0];
    if(!current||current.status==="depleted")return {error:"托盘不存在",status:404 as const};
    if(current.status==="in_task")return {error:"作业中的托盘不能手动编辑，请先完结待办",status:409 as const};
    const target=await getLocationByCode(targetCode,"reserve",tx);
    if(!target)return {error:"请选择有效的备货库位",status:400 as const};
    if(target.id!==current.locationId) {
      const usage=await getLocationSlotUsage(target.id,tx);
      if(!usage?.availableSlots)return {error:`备货库位 ${target.code} 已达到托盘容量`,status:409 as const};
    }

    const now=new Date().toISOString();
    await tx.insert(skus).values({code:skuCode,unit:body.unit?.trim()||"箱",createdAt:now}).onConflictDoNothing({target:skus.code});
    const sku=(await tx.select().from(skus).where(eq(skus.code,skuCode)).limit(1))[0];
    const remarks=body.remarks!==undefined
      ?body.remarks.trim()
      :[
        body.name?.trim()?`商品名称：${body.name.trim()}`:"",
        legacyQuantity>0?`初始数量：${legacyQuantity} ${body.unit?.trim()||"箱"}`:"",
      ].filter(Boolean).join("；")||current.remarks;
    const [updated]=await tx.update(pallets).set({
      skuId:sku.id,locationId:target.id,remarks,inboundAt:requestedInboundAt??current.inboundAt,updatedAt:now,
    }).where(eq(pallets.id,palletId)).returning();
    await tx.insert(movements).values({
      palletId,skuId:sku.id,action:"adjust",fromLocationId:current.locationId,toLocationId:target.id,quantity:0,remarks,occurredAt:now,operatorId:user.id,
    });
    await refreshLocationStatus(current.locationId,tx);
    await refreshLocationStatus(target.id,tx);
    await recordWarehouseRevision(tx);
    return {data:{...updated,sku:sku.code,location:target.code}};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result);
}
