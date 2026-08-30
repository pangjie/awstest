"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "@/lib/client-fetch";
import BrandMark from "./brand-mark";

export default function LoginForm() {
  const router=useRouter();
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
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
      <div className="login-wordmark"><BrandMark className="login-logo-mark"/><div><b>内库</b><span>WAREHOUSE OPERATIONS</span></div></div>
      <div className="login-message">
        <small>FLOW · LOCATION · PEOPLE</small>
        <h1>看见每一次流转，<br/>掌握每一班工况。</h1>
        <p>连接货物、库位、任务与人员，让仓内备货过程可追踪、作业状态可掌握、协同处置更清晰。</p>
      </div>
      <div className="login-stats" aria-label="系统能力">
        <span><i className="blue"/><b>货物流转</b><small>全程可追</small></span>
        <span><i className="mint"/><b>人员工况</b><small>状态清晰</small></span>
        <span><i className="violet"/><b>仓内协同</b><small>任务闭环</small></span>
      </div>
    </section>
    <section className="login-panel">
      <form onSubmit={submit}>
        <div className="mobile-logo"><BrandMark className="login-logo-mark"/><div><b>内库</b><span>WAREHOUSE OPERATIONS</span></div></div>
        <div className="login-kicker"><span/>INTERNAL ACCESS</div>
        <h2>进入内库</h2><p>查看仓内流转、作业任务与人员工况</p>
        <label>账号<input autoFocus autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="请输入内部账号"/></label>
        <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="请输入密码"/></label>
        {error&&<div className="login-error">! {error}</div>}
        <button className="login-button" disabled={busy||!username||!password}>{busy?"正在登录…":<>登录系统 <span aria-hidden="true">→</span></>}</button>
        <small className="login-foot"><i/>内部系统 · 账号与页面权限由管理员配置</small>
      </form>
    </section>
  </main>
}
