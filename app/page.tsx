import type { Metadata } from "next";
import { getInternalUser } from "../lib/internal-auth";
import LoginForm from "./login-form";
import WarehouseApp from "./warehouse-app";

export const metadata: Metadata = {
  title: "内库 · 备货管理",
  description: "整托盘备货、库位与仓内任务管理系统",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getInternalUser();
  if (!user) return <LoginForm />;
  return <WarehouseApp user={user} />;
}
