import type { Metadata } from "next";
import { getInternalUser } from "../lib/internal-auth";
import LoginForm from "./login-form";
import WarehouseApp from "./warehouse-app";

export const metadata: Metadata = {
  title: "内库",
  description: "监测仓库内部货物流转、库位任务与人员工况的内部系统",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getInternalUser();
  if (!user) return <LoginForm />;
  return <WarehouseApp user={user} />;
}
