import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { movements, pallets, skus } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { getLocationByCode, getLocationSlotUsage, refreshLocationStatus } from "../../../../../lib/warehouse-data";
import { warehouseDateTimeInputToIso } from "../../../../../lib/warehouse-time";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function PATCH(request:NextRequest,{params}:{params:Promise<{palletId:string}>}) {
  const user=await getInternalUser();
  if(!user) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const palletId=decodeURIComponent((await params).palletId);
  const body=await request.json().catch(()=>({})) as {sku?:string;remarks?:string;name?:string;quantity?:number;initialQuantity?:number;unit?:string;locationCode?:string;inboundAt?:string};
  const db=getDb();
  const current=(await db.select().from(pallets).where(eq(pallets.id,palletId)).limit(1))[0];
  if(!current||current.status==="depleted") return NextResponse.json({error:{message:"托盘不存在"}},{status:404});
  if(current.status==="in_task") return NextResponse.json({error:{message:"作业中的托盘不能手动编辑，请先完结待办"}},{status:409});
  const skuCode=body.sku?.trim().toUpperCase();
  if(!skuCode) return NextResponse.json({error:{message:"SKU 为必填项"}},{status:400});
  let inboundAt=current.inboundAt;
  if(body.inboundAt) {
    try{inboundAt=warehouseDateTimeInputToIso(body.inboundAt)}
    catch{return NextResponse.json({error:{message:"入库时间无效，请按美东时间填写"}},{status:400})}
  }
  const targetCode=body.locationCode?.trim().toUpperCase();
  if(!targetCode) return NextResponse.json({error:{message:"备货库位为必填项"}},{status:400});
  const target=await getLocationByCode(targetCode,"reserve");
  if(!target||target.type!=="reserve") return NextResponse.json({error:{message:"请选择有效的备货库位"}},{status:400});
  if(target.id!==current.locationId) {
    const usage=await getLocationSlotUsage(target.id);
    if(!usage?.availableSlots) return NextResponse.json({error:{message:`备货库位 ${target.code} 已达到托盘容量`}},{status:409});
  }

  let sku=(await db.select().from(skus).where(eq(skus.code,skuCode)).limit(1))[0];
  if(!sku) [sku]=await db.insert(skus).values({code:skuCode,unit:body.unit?.trim()||"箱",createdAt:new Date().toISOString()}).returning();
  const legacyQuantity=Number(body.initialQuantity??body.quantity);
  const remarks=body.remarks!==undefined
    ?body.remarks.trim()
    :[
      body.name?.trim()?`商品名称：${body.name.trim()}`:"",
      legacyQuantity>0?`初始数量：${legacyQuantity} ${body.unit?.trim()||"箱"}`:"",
    ].filter(Boolean).join("；")||current.remarks;
  const now=new Date().toISOString();
  const [updated]=await db.update(pallets).set({
    skuId:sku.id,locationId:target.id,remarks,inboundAt,updatedAt:now,
  }).where(eq(pallets.id,palletId)).returning();
  await db.insert(movements).values({
    palletId,skuId:sku.id,action:"adjust",fromLocationId:current.locationId,toLocationId:target.id,quantity:0,occurredAt:now,operatorId:user.id,
  });
  await refreshLocationStatus(current.locationId);
  await refreshLocationStatus(target.id);
  await recordWarehouseRevision();
  return NextResponse.json({data:{...updated,sku:sku.code,location:target.code}});
}
