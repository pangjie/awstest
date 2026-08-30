import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { tasks } from "../../../../../../db/schema";
import { authorizePageAccess } from "../../../../../../lib/internal-auth";
import { recordWarehouseRevision } from "../../../../../../lib/warehouse-revision";

export async function POST(_:Request,{params}:{params:Promise<{taskId:string}>}) {
  const access=await authorizePageAccess("dashboard","tasks");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const user=access.user;
  const {taskId}=await params;
  const db=getDb();
  const changed=await db.transaction(async tx=>{
    const rows=await tx.update(tasks).set({status:"claimed",assigneeId:user.id})
      .where(and(eq(tasks.id,taskId),eq(tasks.status,"pending"))).returning({id:tasks.id});
    if(rows.length)await recordWarehouseRevision(tx);
    return rows;
  });
  if(!changed.length) {
    const exists=await db.select({id:tasks.id}).from(tasks).where(eq(tasks.id,taskId)).limit(1);
    return NextResponse.json({error:{message:exists.length?"任务已被其他设备领取或处理":"任务不存在"}},{status:exists.length?409:404});
  }
  return NextResponse.json({data:{id:taskId,status:"claimed"}});
}
