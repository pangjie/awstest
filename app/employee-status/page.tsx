import { getInternalUser } from "@/lib/internal-auth";
import { canAccessAnyPage } from "@/lib/page-permissions";
import LoginForm from "../login-form";
import Link from "next/link";
import EmployeeStatusBoard from "./status-board";
import "./status-board.css";
import { LocalizedText } from "../ui-language";

export const dynamic="force-dynamic";
export const metadata={title:"员工状态 · 内库"};

export default async function EmployeeStatusPage(){
  const user=await getInternalUser();
  if(!user)return <LoginForm/>;
  if(!canAccessAnyPage(user,["time-status"]))return <main className="employee-status-denied"><h1><LocalizedText text="没有员工状态页面的访问权限"/></h1><p><LocalizedText text="请联系管理员授权。"/></p><Link href="/"><LocalizedText text="返回内库"/></Link></main>;
  return <EmployeeStatusBoard/>;
}
