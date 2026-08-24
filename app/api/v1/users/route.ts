import { desc, eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { hashPassword, requireAdmin } from "../../../../lib/internal-auth";
import { recordWarehouseRevision } from "../../../../lib/warehouse-revision";

export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({error:{code:"FORBIDDEN",message:"仅管理员可访问"}},{status:403});
  const rows=await getDb().select({
    id:users.id,username:users.username,email:users.email,name:users.name,role:users.role,active:users.active,createdAt:users.createdAt,
  }).from(users).orderBy(desc(users.createdAt),desc(users.id));
  return NextResponse.json({data:rows});
}

export async function POST(request:NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({error:{code:"FORBIDDEN",message:"仅管理员可操作"}},{status:403});
  const body=await request.json().catch(()=>({})) as {username?:string;email?:string;name?:string;password?:string;role?:"admin"|"manager"|"operator"};
  const username=body.username?.trim().toLowerCase()??"",name=body.name?.trim()??"";
  if(!username||!name||!body.password) return NextResponse.json({error:{code:"INVALID_USER",message:"账号、姓名和密码为必填项"}},{status:400});
  if(body.password.length<12) return NextResponse.json({error:{code:"INVALID_PASSWORD",message:"密码至少需要 12 位"}},{status:400});
  if(body.role&&!(["admin","manager","operator"] as const).includes(body.role)) return NextResponse.json({error:{code:"INVALID_ROLE",message:"账号角色无效"}},{status:400});
  const email=body.email?.trim().toLowerCase()||`${username}@neiku.local`;
  const salt=crypto.randomUUID();
  const passwordHash=await hashPassword(body.password,salt);
  try {
    const result=await getDb().transaction(async tx=>{
      const existing=await tx.select({id:users.id}).from(users).where(or(eq(users.username,username),eq(users.email,email))).limit(1);
      if(existing.length)return {error:true as const};
      const [created]=await tx.insert(users).values({
        username,email,name,passwordHash,passwordSalt:salt,role:body.role??"operator",createdAt:new Date().toISOString(),
      }).returning({id:users.id,username:users.username,name:users.name,role:users.role});
      await recordWarehouseRevision(tx);
      return {data:created};
    });
    if("error" in result)return NextResponse.json({error:{code:"DUPLICATE_USER",message:"登录账号已存在，请更换账号"}},{status:409});
    return NextResponse.json(result,{status:201});
  } catch(error) {
    if((error as {code?:string}).code==="23505")return NextResponse.json({error:{code:"DUPLICATE_USER",message:"登录账号已存在，请更换账号"}},{status:409});
    throw error;
  }
}
