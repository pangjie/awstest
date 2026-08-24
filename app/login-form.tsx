"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "@/lib/client-fetch";

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
      <div className="login-wordmark"><span>内</span><b>内库</b></div>
      <div className="login-message"><small>INTERNAL WAREHOUSE</small><h1>让每一托货物<br/>都有清晰去向。</h1><p>整托备货、库位变化与仓内任务，在一个简单的内部系统中完成闭环。</p></div>
      <div className="login-stats"><span><b>整托</b>库存追踪</span><span><b>库位</b>历史可查</span><span><b>待办</b>作业闭环</span></div>
    </section>
    <section className="login-panel">
      <form onSubmit={submit}>
        <div className="mobile-logo"><span>内</span><b>内库</b></div>
        <div className="login-kicker">WELCOME BACK</div>
        <h2>登录内库</h2><p>使用仓库内部账号继续</p>
        <label>账号<input autoFocus autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="请输入内部账号"/></label>
        <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="请输入密码"/></label>
        {error&&<div className="login-error">! {error}</div>}
        <button className="login-button" disabled={busy||!username||!password}>{busy?"正在登录…":"登录"}</button>
        <small className="login-foot">账号由内库管理员统一创建和维护</small>
      </form>
    </section>
  </main>
}
