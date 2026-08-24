import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../../db";
import { tasks } from "../../../../../../db/schema";
import { getInternalUser } from "../../../../../../lib/internal-auth";
import { recordWarehouseRevision } from "../../../../../../lib/warehouse-revision";

export async function POST(_:Request,{params}:{params:Promise<{taskId:string}>}) {
  const user=await getInternalUser();
  if(!user) return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const {taskId}=await params;
  const db=getDb();
  const changed=await db.update(tasks).set({status:"claimed",assigneeId:user.id})
    .where(and(eq(tasks.id,taskId),eq(tasks.status,"pending"))).returning({id:tasks.id});
  if(!changed.length) {
    const exists=await db.select({id:tasks.id}).from(tasks).where(eq(tasks.id,taskId)).limit(1);
    return NextResponse.json({error:{message:exists.length?"任务已被其他设备领取或处理":"任务不存在"}},{status:exists.length?409:404});
  }
  await recordWarehouseRevision();
  return NextResponse.json({data:{id:taskId,status:"claimed"}});
}
