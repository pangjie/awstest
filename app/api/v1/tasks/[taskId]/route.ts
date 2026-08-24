import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { movements, taskItems, tasks } from "../../../../../db/schema";
import { requireAdmin } from "../../../../../lib/internal-auth";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function DELETE(_:Request,{params}:{params:Promise<{taskId:string}>}) {
  if(!await requireAdmin()) return NextResponse.json({error:{message:"仅管理员可以清理异常任务"}},{status:403});
  const {taskId}=await params;
  const db=getDb();
  const task=(await db.select({id:tasks.id,type:tasks.type,status:tasks.status}).from(tasks).where(eq(tasks.id,taskId)).limit(1))[0];
  if(!task) return NextResponse.json({error:{message:"任务不存在"}},{status:404});
  if(task.type!=="pick") return NextResponse.json({error:{message:"只能清理没有任何明细和操作记录的异常取备货任务"}},{status:409});

  const deleted=await db.delete(tasks).where(and(
    eq(tasks.id,taskId),
    inArray(tasks.status,["pending","claimed"]),
    sql`NOT EXISTS (SELECT 1 FROM ${taskItems} WHERE ${taskItems.taskId} = ${tasks.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${movements} WHERE ${movements.taskId} = ${tasks.id})`,
  )).returning({id:tasks.id});
  if(!deleted.length) {
    return NextResponse.json({error:{message:"该任务包含子任务或操作记录，为保证库存准确，系统拒绝删除"}},{status:409});
  }
  await recordWarehouseRevision();
  return NextResponse.json({data:{id:taskId,deleted:true}});
}
