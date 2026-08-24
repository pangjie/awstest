import { desc, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { locations, pallets, skus, taskItems, tasks } from "../db/schema";

export function getTaskDetailRows(scope:"pending"|"all"="all") {
  const query=getDb().select({
    id:tasks.id,type:tasks.type,status:tasks.status,priority:tasks.priority,dueAt:tasks.dueAt,note:tasks.note,createdAt:tasks.createdAt,completedAt:tasks.completedAt,
    palletId:taskItems.palletId,sku:skus.code,palletRemarks:pallets.remarks,plannedQuantity:taskItems.plannedQuantity,
    actualQuantity:taskItems.actualQuantity,returnedQuantity:taskItems.returnedQuantity,itemNote:taskItems.note,itemOutcome:taskItems.outcome,itemResolvedAt:taskItems.resolvedAt,
    fromLocation:sql<string|null>`fl.code`,fromLocationType:sql<"reserve"|"pick"|null>`fl.type`,
    toLocation:sql<string|null>`tl.code`,toLocationType:sql<"reserve"|"pick"|null>`tl.type`,
  }).from(tasks).leftJoin(taskItems,sql`${taskItems.taskId} = ${tasks.id}`).leftJoin(skus,sql`${taskItems.skuId} = ${skus.id}`)
    .leftJoin(pallets,sql`${taskItems.palletId} = ${pallets.id}`)
    .leftJoin(sql`${locations} AS fl`,sql`fl.id = ${taskItems.fromLocationId}`)
    .leftJoin(sql`${locations} AS tl`,sql`tl.id = ${taskItems.toLocationId}`)
    .where(scope==="pending"?inArray(tasks.status,["pending","claimed"]):undefined)
    .orderBy(desc(tasks.createdAt),desc(taskItems.id));
  return query;
}
