import { desc, eq, isNull, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { hashPassword, requireAdmin } from "../../../../lib/internal-auth";
import { ALL_PAGE_KEYS, effectivePagePermissions, normalizePagePermissions } from "../../../../lib/page-permissions";
import { recordWarehouseRevision } from "../../../../lib/warehouse-revision";

export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({error:{code:"FORBIDDEN",message:"仅管理员可访问"}},{status:403});
  const rows=await getDb().select({
    id:users.id,username:users.username,email:users.email,name:users.name,role:users.role,
    pagePermissions:users.pagePermissions,active:users.active,createdAt:users.createdAt,
  }).from(users).where(isNull(users.deletedAt)).orderBy(desc(users.createdAt),desc(users.id));
  return NextResponse.json({data:rows.map(row=>({
    ...row,pagePermissions:effectivePagePermissions(row.role,row.pagePermissions),
  }))});
}

export async function POST(request:NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({error:{code:"FORBIDDEN",message:"仅管理员可操作"}},{status:403});
  const body=await request.json().catch(()=>({})) as {username?:unknown;email?:unknown;name?:unknown;password?:unknown;role?:unknown;pagePermissions?:unknown};
  const username=typeof body.username==="string"?body.username.trim().toLowerCase():"";
  const password=typeof body.password==="string"?body.password:"";
  const name=typeof body.name==="string"&&body.name.trim()?body.name.trim():username;
  if(!username||!password) return NextResponse.json({error:{code:"INVALID_USER",message:"账号名称和密码为必填项"}},{status:400});
  if(password.length<12) return NextResponse.json({error:{code:"INVALID_PASSWORD",message:"密码至少需要 12 位"}},{status:400});
  if(body.role!==undefined&&!(["admin","manager","operator"] as const).includes(body.role as "admin"|"manager"|"operator")) return NextResponse.json({error:{code:"INVALID_ROLE",message:"账号角色无效"}},{status:400});
  const role=(body.role??"operator") as "admin"|"manager"|"operator";
  const pagePermissions=role==="admin"?[...ALL_PAGE_KEYS]:normalizePagePermissions(body.pagePermissions);
  if(role!=="admin"&&pagePermissions.length===0)return NextResponse.json({error:{code:"INVALID_PERMISSIONS",message:"请至少授权一个子页面"}},{status:400});
  const email=typeof body.email==="string"&&body.email.trim()?body.email.trim().toLowerCase():`${username}@neiku.local`;
  const salt=crypto.randomUUID();
  const passwordHash=await hashPassword(password,salt);
  try {
    const result=await getDb().transaction(async tx=>{
      const existing=await tx.select({id:users.id}).from(users).where(or(eq(users.username,username),eq(users.email,email))).limit(1);
      if(existing.length)return {error:true as const};
      const [created]=await tx.insert(users).values({
        username,email,name,passwordHash,passwordSalt:salt,role,pagePermissions,createdAt:new Date().toISOString(),
      }).returning({id:users.id,username:users.username,name:users.name,role:users.role,pagePermissions:users.pagePermissions});
      await recordWarehouseRevision(tx);
      return {data:{...created,pagePermissions:effectivePagePermissions(created.role,created.pagePermissions)}};
    });
    if("error" in result)return NextResponse.json({error:{code:"DUPLICATE_USER",message:"登录账号已存在，请更换账号"}},{status:409});
    return NextResponse.json(result,{status:201});
  } catch(error) {
    if((error as {code?:string}).code==="23505")return NextResponse.json({error:{code:"DUPLICATE_USER",message:"登录账号已存在，请更换账号"}},{status:409});
    throw error;
  }
}
