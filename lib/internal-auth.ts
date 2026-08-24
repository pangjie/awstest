import { and, eq, gt } from "drizzle-orm";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { cookies, headers } from "next/headers";
import { getDb } from "../db";
import { sessions, users } from "../db/schema";
import { ensureRuntimeSchema } from "../db/runtime";

export const SESSION_COOKIE = "neiku_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_REFRESH_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000;
export type InternalUser = { id:number; username:string; name:string; role:"admin"|"manager"|"operator" };

type InitialAdminCredentials={username:string;password:string};
let initialAdminCredentials:Promise<InitialAdminCredentials>|null=null;

async function loadInitialAdminCredentials():Promise<InitialAdminCredentials> {
  const explicitPassword=process.env.INITIAL_ADMIN_PASSWORD??"";
  const explicitUsername=(process.env.INITIAL_ADMIN_USERNAME??"admin").trim().toLowerCase();
  if(explicitPassword)return {username:explicitUsername,password:explicitPassword};
  if(process.env.NODE_ENV!=="production")throw new Error("INITIAL_ADMIN_PASSWORD is required before the first login");

  const secretId=process.env.INITIAL_ADMIN_SECRET_ID??"aws-miniflow/initial-admin";
  const client=new SecretsManagerClient({region:process.env.AWS_REGION??"us-east-2"});
  let secretString="";
  try {
    secretString=(await client.send(new GetSecretValueCommand({SecretId:secretId}))).SecretString??"";
  } catch(error) {
    if((error as {name?:string}).name!=="ResourceNotFoundException")throw error;
  }
  if(!secretString) {
    const password=Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    secretString=JSON.stringify({username:explicitUsername,password});
    await client.send(new PutSecretValueCommand({SecretId:secretId,SecretString:secretString}));
  }
  const parsed=JSON.parse(secretString) as Partial<InitialAdminCredentials>;
  const username=String(parsed.username??explicitUsername).trim().toLowerCase();
  const password=String(parsed.password??"");
  if(!username||password.length<12)throw new Error("The initial admin secret is missing a valid username or password");
  return {username,password};
}

export async function ensureDefaultAdmin() {
  await ensureRuntimeSchema();
  const db=getDb();
  if((await db.select({id:users.id}).from(users).limit(1)).length)return;
  initialAdminCredentials??=loadInitialAdminCredentials().catch(error=>{
    initialAdminCredentials=null;
    throw error;
  });
  const {username,password}=await initialAdminCredentials;
  if(password.length<12)throw new Error("INITIAL_ADMIN_PASSWORD must contain at least 12 characters");
  const passwordSalt=crypto.randomUUID();
  await db.insert(users).values({
    username,
    email:`${username}@neiku.local`,
    name:"系统管理员",
    passwordSalt,
    passwordHash:await hashPassword(password,passwordSalt),
    role:"admin",
    createdAt:new Date().toISOString(),
  }).onConflictDoNothing({target:users.username});
}

export async function hashPassword(password:string, salt:string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt:new TextEncoder().encode(salt), iterations:100000 }, key, 256);
  return Array.from(new Uint8Array(bits)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

export function secureEqual(a:string,b:string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getInternalUser():Promise<InternalUser|null> {
  await ensureRuntimeSchema();
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await getDb().select({
    id:users.id, username:users.username, name:users.name, role:users.role, expiresAt:sessions.expiresAt,
  }).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date().toISOString()), eq(users.active, true))).limit(1);
  const current = rows[0];
  if (!current) return null;

  const expiresAt = new Date(current.expiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + SESSION_REFRESH_THRESHOLD_MS) {
    const refreshedExpiry = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
    try {
      const requestHeaders = await headers();
      const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
      const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const secure = process.env.NODE_ENV==="production"||(forwardedProtocol ? forwardedProtocol === "https" : !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host));
      cookieStore.set(SESSION_COOKIE, token, {
        httpOnly:true,
        secure,
        sameSite:"strict",
        path:"/",
        expires:refreshedExpiry,
        maxAge:SESSION_MAX_AGE_SECONDS,
      });
      await getDb().update(sessions).set({ expiresAt:refreshedExpiry.toISOString() }).where(eq(sessions.id, token));
    } catch {
      // Server Components cannot mutate cookies. The next authenticated API request performs the renewal.
    }
  }

  return { id:current.id, username:current.username, name:current.name, role:current.role };
}

export async function requireAdmin() {
  const user = await getInternalUser();
  return user?.role === "admin" ? user : null;
}
