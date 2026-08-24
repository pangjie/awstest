import fs from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
let pool:InstanceType<typeof Pool>|null=null;

function databaseSslConfig(env:NodeJS.ProcessEnv=process.env) {
  const mode=env.DB_SSL??(env.NODE_ENV==="production"?"verify-full":"disable");
  if(mode==="disable")return false;
  if(mode!=="verify-full")throw new Error("DB_SSL must be either disable or verify-full");
  if(!env.DB_CA_PATH)throw new Error("DB_CA_PATH is required when DB_SSL=verify-full");
  return {ca:fs.readFileSync(env.DB_CA_PATH,"utf8"),rejectUnauthorized:true};
}

function connectionConfig(env:NodeJS.ProcessEnv=process.env) {
  if(env.DATABASE_URL)return {connectionString:env.DATABASE_URL};
  if(!env.DB_HOST||!env.DB_NAME||!env.DB_USER||!env.DB_PASSWORD) {
    throw new Error("DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD is required");
  }
  return {
    host:env.DB_HOST,
    port:Number(env.DB_PORT??5432),
    database:env.DB_NAME,
    user:env.DB_USER,
    password:env.DB_PASSWORD,
  };
}

export function getPool() {
  pool??=new Pool({
    ...connectionConfig(),
    ssl:databaseSslConfig(),
    max:Number(process.env.DB_POOL_MAX??5),
    connectionTimeoutMillis:5_000,
    idleTimeoutMillis:30_000,
    application_name:"aws-miniflow-neiku",
  });
  return pool;
}

export function getDb() {
  return drizzle(getPool(),{schema});
}
