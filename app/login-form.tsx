"use client";
import { t, useLanguage } from "@/app/ui-language";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "@/lib/client-fetch";
import BrandMark from "./brand-mark";

export default function LoginForm() {
  useLanguage();
  const router=useRouter();
  const [canSubmit,setCanSubmit]=useState(false);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent) {
    e.preventDefault();
    const fields=new FormData(e.currentTarget as HTMLFormElement);
    const username=String(fields.get("username")??"");
    const password=String(fields.get("password")??"");
    if(busy||!username||!password)return;
    setBusy(true); setError("");
    try {
      const res=await fetchWithTimeout("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,password})});
      if(res.ok){router.refresh();return}
      const body=await res.json().catch(()=>({}));
      setError(body?.error?.message??"登录失败，请重试");
    } catch(error) {
      setError(error instanceof Error?error.message:"登录失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return <main className="login-page">
    <section className="login-brand">
      <div className="login-brand-art" aria-hidden="true"/>
      <div className="login-brand-shade" aria-hidden="true"/>
      <div className="login-wordmark"><BrandMark className="login-logo-mark"/><div><b>{t("内库")}</b><span>WAREHOUSE OPERATIONS</span></div></div>
      <div className="login-message">
        <small>FLOW · LOCATION · PEOPLE</small>
        <h1 data-ui-size="">{t("看见每一次流转，")}<br/>{t("掌握每一班工况。")}</h1>
        <p>{t("连接货物、库位、任务与人员，让仓内备货过程可追踪、作业状态可掌握、协同处置更清晰。")}</p>
      </div>
      <div className="login-stats" aria-label={t("系统能力")}>
        <span><i className="blue"/><b>{t("货物流转")}</b><small>{t("全程可追")}</small></span>
        <span><i className="mint"/><b>{t("人员工况")}</b><small>{t("状态清晰")}</small></span>
        <span><i className="violet"/><b>{t("仓内协同")}</b><small>{t("任务闭环")}</small></span>
      </div>
    </section>
    <section className="login-panel">
      <form onSubmit={submit} onInput={event=>{const fields=new FormData(event.currentTarget);setCanSubmit(Boolean(fields.get("username")&&fields.get("password")))}}>
        <div className="mobile-logo"><BrandMark className="login-logo-mark"/><div><b>{t("内库")}</b><span>WAREHOUSE OPERATIONS</span></div></div>
        <div className="login-kicker"><span/>INTERNAL ACCESS</div>
        <h2 data-ui-size="">{t("进入内库")}</h2><p>{t("查看仓内流转、作业任务与人员工况")}</p>
        <label>{t("账号")}<input name="username" autoComplete="username" required placeholder={t("请输入内部账号")}/></label>
        <label>{t("密码")}<input name="password" type="password" autoComplete="current-password" required placeholder={t("请输入密码")}/></label>
        {error&&<div className="login-error">! {t(error)}</div>}
        <button className="login-button" disabled={busy||!canSubmit} data-ui-size="">{busy?t("正在登录…"):<>{t("登录系统")} <span aria-hidden="true">→</span></>}</button>
        <small className="login-foot"><i/>{t("内部系统 · 账号与页面权限由管理员配置")}</small>
      </form>
    </section>
  </main>
}
