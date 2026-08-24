import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./warehouse-enhancements.css";

const assetRecoveryScript = `(()=>{
  const key="neiku_asset_reload_at";
  const retryWindow=60000;
  const isAssetFailure=(event)=>{
    const target=event&&event.target;
    if(target&&(target.tagName==="SCRIPT"||target.tagName==="LINK"))return true;
    const reason=event&&event.reason;
    const message=String((reason&&(reason.message||reason))||(event&&event.message)||"");
    return /ChunkLoadError|Loading chunk|dynamically imported module|module script/i.test(message);
  };
  const recover=(event)=>{
    if(!isAssetFailure(event))return;
    const now=Date.now();
    const url=new URL(location.href);
    let last=0;
    try{last=Number(sessionStorage.getItem(key)||0);}catch{}
    if(url.searchParams.has("__neiku_reload")||now-last<retryWindow)return;
    try{sessionStorage.setItem(key,String(now));}catch{}
    url.searchParams.set("__neiku_reload",String(now));
    location.replace(url.toString());
  };
  addEventListener("error",recover,true);
  addEventListener("unhandledrejection",recover);
  setTimeout(()=>{
    try{sessionStorage.removeItem(key);}catch{}
    const url=new URL(location.href);
    if(url.searchParams.delete("__neiku_reload"))history.replaceState(null,"",url.toString());
  },30000);
})();`;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  return {
    metadataBase: base,
    title: "内库 · 备货管理系统",
    description: "面向整托盘备货与仓内移动的轻量 WMS",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "内库",
      description: "整托备货 · 清晰流转",
      type: "website",
      images: [{ url: new URL("/og.png", base).toString(), width: 1200, height: 630, alt: "内库整托备货管理系统" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "内库",
      description: "整托备货 · 清晰流转",
      images: [new URL("/og.png", base).toString()],
    },
  };
}

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="zh-CN"><head><script dangerouslySetInnerHTML={{__html:assetRecoveryScript}}/></head><body>{children}</body></html>;
}
