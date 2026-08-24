import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { pallets, taskItems, tasks } from "../../../../db/schema";
import { getInternalUser } from "../../../../lib/internal-auth";
import { getLocationByCode, getLocationSlotUsage } from "../../../../lib/warehouse-data";
import { getTaskDetailRows } from "../../../../lib/warehouse-read-model";
import { warehouseDateKey } from "../../../../lib/warehouse-time";
import { recordWarehouseRevision } from "../../../../lib/warehouse-revision";

export async function GET(request:NextRequest) {
  if(!await getInternalUser()) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  if(request.nextUrl.searchParams.get("detail")==="1") {
    return NextResponse.json({data:await getTaskDetailRows("all")},{headers:{"cache-control":"no-store"}});
  }
  return NextResponse.json({data:await getDb().select().from(tasks).orderBy(desc(tasks.createdAt),desc(tasks.id))});
}

export async function POST(request:NextRequest) {
  const user=await getInternalUser();
  if(!user) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const body=await request.json().catch(()=>({})) as {
    type?:"store"|"pick"|"move";priority?:"normal"|"urgent";dueAt?:string;note?:string;
    palletIds?:string[];toLocationCode?:string;
    pickItems?:Array<{palletId:string;toLocationCode:string;note?:string}>;
    moveItems?:Array<{palletId:string;toLocationCode:string}>;
  };
  if(!body.type) return NextResponse.json({error:{message:"请选择任务类型"}},{status:400});
  if(body.type==="store") return NextResponse.json({error:{message:"存备货为直接入库操作，请使用 /api/v1/pallets/inbound"}},{status:400});
  const db=getDb();
  const now=new Date();
  const id=`TK-${warehouseDateKey(now).slice(2).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
  const targetByPalletId=new Map<string,number>();
  const noteByPalletId=new Map<string,string>();
  let resolvedPallets:typeof pallets.$inferSelect[]=[];

  if(body.type==="pick") {
    const pickItems:Array<{palletId:string;toLocationCode:string;note?:string}>=body.pickItems?.length?body.pickItems:(body.palletIds?.length&&body.toLocationCode?body.palletIds.map(palletId=>({palletId,toLocationCode:body.toLocationCode!})):[]);
    if(!pickItems.length) return NextResponse.json({error:{message:"请添加取备货明细，并选择备货托盘和主库位"}},{status:400});
    const palletIds=pickItems.map(item=>item.palletId);
    if(new Set(palletIds).size!==palletIds.length) return NextResponse.json({error:{message:"取备货任务中存在重复托盘"}},{status:400});
    resolvedPallets=await db.select().from(pallets).where(inArray(pallets.id,palletIds));
    if(resolvedPallets.length!==palletIds.length||resolvedPallets.some(p=>p.status!=="in_stock")) return NextResponse.json({error:{message:"所选托盘不存在或已在任务中"}},{status:409});
    for(const item of pickItems) {
      const target=await getLocationByCode(item.toLocationCode,"pick");
      if(!target) return NextResponse.json({error:{message:`主库位 ${item.toLocationCode} 无效`}},{status:400});
      const note=String(item.note??"").trim();
      if(note.length>500) return NextResponse.json({error:{message:"子任务备注不能超过 500 个字符"}},{status:400});
      targetByPalletId.set(item.palletId,target.id);
      noteByPalletId.set(item.palletId,note);
    }
  } else {
    const moveItems=body.moveItems?.length?body.moveItems:(body.palletIds?.length===1&&body.toLocationCode?[{palletId:body.palletIds[0],toLocationCode:body.toLocationCode}]:[]);
    if(!moveItems.length) return NextResponse.json({error:{message:"请选择待迁移托盘，并为每托分配目标库位"}},{status:400});
    const palletIds=moveItems.map(item=>item.palletId);
    if(new Set(palletIds).size!==palletIds.length) return NextResponse.json({error:{message:"迁移任务中存在重复托盘"}},{status:400});
    resolvedPallets=await db.select().from(pallets).where(inArray(pallets.id,palletIds));
    if(resolvedPallets.length!==palletIds.length||resolvedPallets.some(p=>p.status!=="in_stock")) return NextResponse.json({error:{message:"所选托盘不存在或已在任务中"}},{status:409});
    const requestedByTarget=new Map<number,{code:string;count:number}>();
    for(const item of moveItems) {
      const target=await getLocationByCode(item.toLocationCode,"reserve");
      if(!target) return NextResponse.json({error:{message:`迁移目标 ${item.toLocationCode} 无效`}},{status:400});
      const pallet=resolvedPallets.find(row=>row.id===item.palletId)!;
      if(pallet.locationId===target.id) return NextResponse.json({error:{message:`托盘 ${item.palletId} 已在 ${target.code}`}},{status:400});
      targetByPalletId.set(item.palletId,target.id);
      const requested=requestedByTarget.get(target.id);
      requestedByTarget.set(target.id,{code:target.code,count:(requested?.count??0)+1});
    }
    for(const [locationId,requested] of requestedByTarget) {
      const usage=await getLocationSlotUsage(locationId);
      if(!usage||usage.availableSlots<requested.count) {
        return NextResponse.json({error:{message:`备货库位 ${requested.code} 剩余容量不足（可用 ${usage?.availableSlots??0} 托）`}},{status:409});
      }
    }
  }

  const palletIds=resolvedPallets.map(p=>p.id);
  const claimedAt=now.toISOString();
  try {
    await db.transaction(async tx=>{
      const claimed=await tx.update(pallets).set({status:"in_task",updatedAt:claimedAt})
        .where(and(eq(pallets.status,"in_stock"),inArray(pallets.id,palletIds))).returning({id:pallets.id});
      if(claimed.length!==palletIds.length)throw new Error("PALLET_CONFLICT");
      await tx.insert(tasks).values({
        id,type:body.type!,status:"pending",priority:body.priority??"normal",dueAt:body.dueAt??null,
        note:body.note??null,createdById:user.id,createdAt:claimedAt,
      });
      await tx.insert(taskItems).values(resolvedPallets.map(p=>({
        taskId:id,palletId:p.id,skuId:p.skuId,fromLocationId:p.locationId,
        toLocationId:targetByPalletId.get(p.id)!,plannedQuantity:0,returnedQuantity:0,
        note:body.type==="pick"?(noteByPalletId.get(p.id)??""):null,
      })));
    });
  } catch(error) {
    if(error instanceof Error&&error.message==="PALLET_CONFLICT") {
      return NextResponse.json({error:{message:"部分托盘已被其他设备加入任务，请刷新后重新选择"}},{status:409});
    }
    return NextResponse.json({error:{message:"待办任务创建未完成，系统已取消本次操作，请刷新后重试"}},{status:409});
  }
  await recordWarehouseRevision();
  return NextResponse.json({data:{id,status:"pending"}},{status:201});
}
