import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { locations, movements, pallets, taskItems, tasks } from "../../../../../../db/schema";
import { getInternalUser } from "../../../../../../lib/internal-auth";
import { createPalletId, getLocationSlotUsage, refreshLocationStatus } from "../../../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../../../lib/warehouse-revision";

export async function POST(request:NextRequest,{params}:{params:Promise<{taskId:string}>}) {
  const user=await getInternalUser();
  if(!user) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const {taskId}=await params;
  const body=await request.json().catch(()=>({})) as {outcome?:"completed"|"returned"|"partial";palletId?:string};
  if(!["completed","returned","partial"].includes(body.outcome??"")) return NextResponse.json({error:{message:"请选择有效的完结方式"}},{status:400});
  const db=getDb();
  const task=(await db.select().from(tasks).where(eq(tasks.id,taskId)).limit(1))[0];
  if(!task) return NextResponse.json({error:{message:"任务不存在"}},{status:404});
  if(!["pending","claimed"].includes(task.status)) return NextResponse.json({error:{message:"任务已经完结"}},{status:409});
  if(body.outcome==="partial"&&task.type!=="pick") return NextResponse.json({error:{message:"只有取备货任务可以部分完成"}},{status:400});
  const items=await db.select().from(taskItems).where(eq(taskItems.taskId,taskId));
  const now=new Date();
  const nowIso=now.toISOString();

  if(task.type==="pick") {
    if(!body.palletId) return NextResponse.json({error:{message:"取备货任务必须逐托确认"}},{status:400});
    const item=items.find(row=>row.palletId===body.palletId);
    if(!item) return NextResponse.json({error:{message:"该托盘不属于此取备货任务"}},{status:404});
    if(item.outcome!==null) return NextResponse.json({error:{message:"该托盘已经确认，不能重复处理"}},{status:409});
    if(!item.palletId) return NextResponse.json({error:{message:"任务明细缺少托盘信息"}},{status:409});
    const pallet=(await db.select().from(pallets).where(eq(pallets.id,item.palletId)).limit(1))[0];
    if(!pallet) return NextResponse.json({error:{message:"托盘不存在"}},{status:404});
    const claimedItem=await db.update(taskItems).set({outcome:body.outcome,resolvedAt:nowIso})
      .where(and(eq(taskItems.id,item.id),isNull(taskItems.outcome),isNull(taskItems.resolvedAt)))
      .returning({id:taskItems.id});
    if(!claimedItem.length)return NextResponse.json({error:{message:"该托盘已被其他设备确认，请刷新任务"}},{status:409});

    if(body.outcome==="returned") {
      await db.update(pallets).set({status:"in_stock",updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
      await db.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"return",fromLocationId:item.fromLocationId,toLocationId:item.fromLocationId,quantity:item.plannedQuantity,occurredAt:nowIso,operatorId:user.id});
      await db.update(taskItems).set({actualQuantity:0,returnedQuantity:item.plannedQuantity,outcome:"returned",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
    } else if(body.outcome==="partial") {
      await db.update(pallets).set({status:"in_stock",locationId:item.fromLocationId,updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
      await db.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"partial_pick",fromLocationId:item.fromLocationId,toLocationId:item.toLocationId,quantity:0,occurredAt:nowIso,operatorId:user.id});
      await db.update(taskItems).set({actualQuantity:null,returnedQuantity:item.plannedQuantity,outcome:"partial",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
    } else {
      await db.update(pallets).set({status:"depleted",locationId:null,updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
      await db.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"pick",fromLocationId:item.fromLocationId,toLocationId:item.toLocationId,quantity:item.plannedQuantity,occurredAt:nowIso,operatorId:user.id});
      await db.update(taskItems).set({actualQuantity:item.plannedQuantity,returnedQuantity:0,outcome:"completed",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
    }
    await refreshLocationStatus(item.fromLocationId);

    const updatedItems=await db.select().from(taskItems).where(eq(taskItems.taskId,taskId));
    const allConfirmed=updatedItems.every(row=>row.outcome!==null);
    let taskStatus=task.status;
    if(allConfirmed) {
      taskStatus=updatedItems.every(row=>row.outcome==="completed")
        ?"completed"
        :updatedItems.every(row=>row.outcome==="returned")
          ?"returned"
          :"partial";
      await db.update(tasks).set({status:taskStatus,completedAt:nowIso}).where(eq(tasks.id,taskId));
    }
    await recordWarehouseRevision();
    return NextResponse.json({data:{id:taskId,palletId:item.palletId,itemOutcome:body.outcome,status:taskStatus,allConfirmed}});
  }

  if(body.outcome==="completed"&&["store","move"].includes(task.type)) {
    const incomingByLocation=new Map<number,number>();
    const outgoingByLocation=new Map<number,number>();
    for(const item of items) {
      if(item.toLocationId) incomingByLocation.set(item.toLocationId,(incomingByLocation.get(item.toLocationId)??0)+1);
      if(task.type==="move"&&item.fromLocationId) outgoingByLocation.set(item.fromLocationId,(outgoingByLocation.get(item.fromLocationId)??0)+1);
    }
    for(const [locationId,incoming] of incomingByLocation) {
      const usage=await getLocationSlotUsage(locationId);
      const occupiedAfterCompletion=Number(usage?.palletCount??0)-(outgoingByLocation.get(locationId)??0)+incoming;
      if(!usage||occupiedAfterCompletion>usage.capacity) {
        return NextResponse.json({error:{message:`目标库位 ${usage?.code??locationId} 容量不足，请重新安排库位后再完结任务`}},{status:409});
      }
    }
  }
  const reservedTask=await db.update(tasks).set({status:body.outcome,completedAt:nowIso})
    .where(and(eq(tasks.id,taskId),inArray(tasks.status,["pending","claimed"])))
    .returning({id:tasks.id});
  if(!reservedTask.length)return NextResponse.json({error:{message:"任务已被其他设备处理，请刷新后查看"}},{status:409});
  for(let index=0;index<items.length;index++) {
    const item=items[index];
    if(task.type==="store") {
      if(body.outcome!=="completed") {
        await db.update(taskItems).set({actualQuantity:0,returnedQuantity:item.plannedQuantity,outcome:"returned",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
        await refreshLocationStatus(item.toLocationId);
        continue;
      }
      let sequence=(now.getUTCMilliseconds()+index)%9999+1;
      let palletId=createPalletId(sequence,now);
      while((await db.select({id:pallets.id}).from(pallets).where(eq(pallets.id,palletId)).limit(1)).length) {
        sequence=sequence%9999+1;
        palletId=createPalletId(sequence,now);
      }
      await db.insert(pallets).values({id:palletId,skuId:item.skuId,locationId:item.toLocationId,remarks:"",inboundAt:nowIso,updatedAt:nowIso});
      await db.insert(movements).values({palletId,skuId:item.skuId,taskId,action:"inbound",toLocationId:item.toLocationId,quantity:item.plannedQuantity,occurredAt:nowIso,operatorId:user.id});
      if(item.toLocationId) await db.update(locations).set({status:"occupied"}).where(eq(locations.id,item.toLocationId));
      await db.update(taskItems).set({actualQuantity:item.plannedQuantity,outcome:"completed",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      continue;
    }
    if(!item.palletId) continue;
    const pallet=(await db.select().from(pallets).where(eq(pallets.id,item.palletId)).limit(1))[0];
    if(!pallet) continue;
    if(body.outcome==="returned") {
      await db.update(pallets).set({status:"in_stock",updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
      await db.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"return",fromLocationId:item.fromLocationId,toLocationId:item.fromLocationId,quantity:item.plannedQuantity,occurredAt:nowIso,operatorId:user.id});
      await db.update(taskItems).set({actualQuantity:0,returnedQuantity:item.plannedQuantity,outcome:"returned",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      if(task.type==="move") await refreshLocationStatus(item.toLocationId);
    } else {
      await db.update(pallets).set({status:"in_stock",locationId:item.toLocationId,updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
      await db.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"move",fromLocationId:item.fromLocationId,toLocationId:item.toLocationId,quantity:item.plannedQuantity,occurredAt:nowIso,operatorId:user.id});
      if(item.toLocationId) await db.update(locations).set({status:"occupied"}).where(eq(locations.id,item.toLocationId));
      await db.update(taskItems).set({actualQuantity:item.plannedQuantity,outcome:"completed",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      await refreshLocationStatus(item.fromLocationId);
      await refreshLocationStatus(item.toLocationId);
    }
  }
  const affectedLocationIds=Array.from(new Set(items.flatMap(item=>[item.fromLocationId,item.toLocationId]).filter((id):id is number=>id!==null)));
  for(const locationId of affectedLocationIds) await refreshLocationStatus(locationId);
  await recordWarehouseRevision();
  return NextResponse.json({data:{id:taskId,status:body.outcome}});
}
