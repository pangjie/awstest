import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { locations, movements, pallets, taskItems, tasks } from "../../../../../../db/schema";
import { authorizePageAccess } from "../../../../../../lib/internal-auth";
import { createPalletId, getLocationSlotUsage, lockWarehouseInventory, refreshLocationStatus } from "../../../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../../../lib/warehouse-revision";

type CompletionResult=
  |{error:string;status:400|404|409}
  |{data:{id:string;status:string;palletId?:string;itemOutcome?:string;allConfirmed?:boolean}};

export async function POST(request:NextRequest,{params}:{params:Promise<{taskId:string}>}) {
  const access=await authorizePageAccess("dashboard","tasks");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const user=access.user;
  const {taskId}=await params;
  const body=await request.json().catch(()=>({})) as {outcome?:"completed"|"returned"|"partial";palletId?:string};
  if(!["completed","returned","partial"].includes(body.outcome??"")) {
    return NextResponse.json({error:{message:"请选择有效的完结方式"}},{status:400});
  }

  const result:CompletionResult=await getDb().transaction(async tx=>{
    await lockWarehouseInventory(tx);
    await tx.execute(sql`SELECT id FROM ${tasks} WHERE ${tasks.id}=${taskId} FOR UPDATE`);
    const task=(await tx.select().from(tasks).where(eq(tasks.id,taskId)).limit(1))[0];
    if(!task)return {error:"任务不存在",status:404};
    if(!["pending","claimed"].includes(task.status))return {error:"任务已经完结",status:409};
    if(body.outcome==="partial"&&task.type!=="pick")return {error:"只有取备货任务可以部分完成",status:400};

    const items=await tx.select().from(taskItems).where(eq(taskItems.taskId,taskId));
    const now=new Date(),nowIso=now.toISOString();
    if(task.type==="pick") {
      if(!body.palletId)return {error:"取备货任务必须逐托确认",status:400};
      const item=items.find(row=>row.palletId===body.palletId);
      if(!item)return {error:"该托盘不属于此取备货任务",status:404};
      if(item.outcome!==null)return {error:"该托盘已经确认，不能重复处理",status:409};
      const pallet=(await tx.select().from(pallets).where(eq(pallets.id,body.palletId)).limit(1))[0];
      if(!pallet)return {error:"托盘不存在",status:404};

      const claimedItem=await tx.update(taskItems).set({outcome:body.outcome,resolvedAt:nowIso})
        .where(and(eq(taskItems.id,item.id),isNull(taskItems.outcome),isNull(taskItems.resolvedAt)))
        .returning({id:taskItems.id});
      if(!claimedItem.length)return {error:"该托盘已被其他设备确认，请刷新任务",status:409};

      if(body.outcome==="returned") {
        await tx.update(pallets).set({status:"in_stock",updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
        await tx.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"return",fromLocationId:item.fromLocationId,toLocationId:item.fromLocationId,quantity:item.plannedQuantity,remarks:pallet.remarks,occurredAt:nowIso,operatorId:user.id});
        await tx.update(taskItems).set({actualQuantity:0,returnedQuantity:item.plannedQuantity,outcome:"returned",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      } else if(body.outcome==="partial") {
        await tx.update(pallets).set({status:"in_stock",locationId:item.fromLocationId,updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
        await tx.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"partial_pick",fromLocationId:item.fromLocationId,toLocationId:item.toLocationId,quantity:0,remarks:pallet.remarks,occurredAt:nowIso,operatorId:user.id});
        await tx.update(taskItems).set({actualQuantity:null,returnedQuantity:item.plannedQuantity,outcome:"partial",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      } else {
        await tx.update(pallets).set({status:"depleted",locationId:null,updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
        await tx.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"pick",fromLocationId:item.fromLocationId,toLocationId:item.toLocationId,quantity:item.plannedQuantity,remarks:pallet.remarks,occurredAt:nowIso,operatorId:user.id});
        await tx.update(taskItems).set({actualQuantity:item.plannedQuantity,returnedQuantity:0,outcome:"completed",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      }
      await refreshLocationStatus(item.fromLocationId,tx);

      const updatedItems=await tx.select().from(taskItems).where(eq(taskItems.taskId,taskId));
      const allConfirmed=updatedItems.every(row=>row.outcome!==null);
      let taskStatus=task.status;
      if(allConfirmed) {
        taskStatus=updatedItems.every(row=>row.outcome==="completed")
          ?"completed"
          :updatedItems.every(row=>row.outcome==="returned")
            ?"returned"
            :"partial";
        await tx.update(tasks).set({status:taskStatus,completedAt:nowIso}).where(eq(tasks.id,taskId));
      }
      await recordWarehouseRevision(tx);
      return {data:{id:taskId,palletId:body.palletId,itemOutcome:body.outcome,status:taskStatus,allConfirmed}};
    }

    if(task.type==="store"&&items.some(item=>item.toLocationId===null)) {
      return {error:"存备货任务明细缺少目标库位",status:409};
    }
    const palletIds=items.flatMap(item=>item.palletId?[item.palletId]:[]);
    const taskPallets=task.type==="store"?[]:await tx.select().from(pallets).where(inArray(pallets.id,palletIds));
    if(task.type!=="store"&&(palletIds.length!==items.length||taskPallets.length!==items.length)) {
      return {error:"任务明细中的托盘不存在，请联系管理员",status:409};
    }
    const palletById=new Map(taskPallets.map(pallet=>[pallet.id,pallet]));

    if(body.outcome==="completed"&&["store","move"].includes(task.type)) {
      const incomingByLocation=new Map<number,number>(),outgoingByLocation=new Map<number,number>();
      for(const item of items) {
        if(item.toLocationId)incomingByLocation.set(item.toLocationId,(incomingByLocation.get(item.toLocationId)??0)+1);
        if(task.type==="move"&&item.fromLocationId)outgoingByLocation.set(item.fromLocationId,(outgoingByLocation.get(item.fromLocationId)??0)+1);
      }
      for(const [locationId,incoming] of incomingByLocation) {
        const usage=await getLocationSlotUsage(locationId,tx);
        const occupiedAfterCompletion=Number(usage?.palletCount??0)-(outgoingByLocation.get(locationId)??0)+incoming;
        if(!usage||occupiedAfterCompletion>usage.capacity) {
          return {error:`目标库位 ${usage?.code??locationId} 容量不足，请重新安排库位后再完结任务`,status:409};
        }
      }
    }

    const reservedTask=await tx.update(tasks).set({status:body.outcome!,completedAt:nowIso})
      .where(and(eq(tasks.id,taskId),inArray(tasks.status,["pending","claimed"])))
      .returning({id:tasks.id});
    if(!reservedTask.length)return {error:"任务已被其他设备处理，请刷新后查看",status:409};

    for(let index=0;index<items.length;index++) {
      const item=items[index];
      if(task.type==="store") {
        if(body.outcome!=="completed") {
          await tx.update(taskItems).set({actualQuantity:0,returnedQuantity:item.plannedQuantity,outcome:"returned",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
          await refreshLocationStatus(item.toLocationId,tx);
          continue;
        }
        let sequence=(now.getUTCMilliseconds()+index)%9999+1,palletId="";
        for(let attempts=0;attempts<9_999;attempts++,sequence=sequence%9999+1) {
          const candidate=createPalletId(sequence,now);
          if(!(await tx.select({id:pallets.id}).from(pallets).where(eq(pallets.id,candidate)).limit(1)).length) {
            palletId=candidate;break;
          }
        }
        if(!palletId)throw new Error("当天托盘编号已用尽");
        await tx.insert(pallets).values({id:palletId,skuId:item.skuId,locationId:item.toLocationId,remarks:"",inboundAt:nowIso,updatedAt:nowIso});
        await tx.insert(movements).values({palletId,skuId:item.skuId,taskId,action:"inbound",toLocationId:item.toLocationId,quantity:item.plannedQuantity,remarks:"",occurredAt:nowIso,operatorId:user.id});
        await tx.update(locations).set({status:"occupied"}).where(eq(locations.id,item.toLocationId!));
        await tx.update(taskItems).set({actualQuantity:item.plannedQuantity,outcome:"completed",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
        continue;
      }

      const pallet=palletById.get(item.palletId!)!;
      if(body.outcome==="returned") {
        await tx.update(pallets).set({status:"in_stock",updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
        await tx.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"return",fromLocationId:item.fromLocationId,toLocationId:item.fromLocationId,quantity:item.plannedQuantity,remarks:pallet.remarks,occurredAt:nowIso,operatorId:user.id});
        await tx.update(taskItems).set({actualQuantity:0,returnedQuantity:item.plannedQuantity,outcome:"returned",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      } else {
        await tx.update(pallets).set({status:"in_stock",locationId:item.toLocationId,updatedAt:nowIso}).where(eq(pallets.id,pallet.id));
        await tx.insert(movements).values({palletId:pallet.id,skuId:pallet.skuId,taskId,action:"move",fromLocationId:item.fromLocationId,toLocationId:item.toLocationId,quantity:item.plannedQuantity,remarks:pallet.remarks,occurredAt:nowIso,operatorId:user.id});
        await tx.update(taskItems).set({actualQuantity:item.plannedQuantity,outcome:"completed",resolvedAt:nowIso}).where(eq(taskItems.id,item.id));
      }
    }
    const affectedLocationIds=Array.from(new Set(items.flatMap(item=>[item.fromLocationId,item.toLocationId]).filter((id):id is number=>id!==null)));
    for(const locationId of affectedLocationIds)await refreshLocationStatus(locationId,tx);
    await recordWarehouseRevision(tx);
    return {data:{id:taskId,status:body.outcome!}};
  });

  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result);
}
