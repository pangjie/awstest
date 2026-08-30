import { fetchWithTimeout } from "@/lib/client-fetch";

export async function timeApi<T>(url:string,options:RequestInit={}){
  const response=await fetchWithTimeout(url,{...options,cache:"no-store",headers:{...(options.body?{"content-type":"application/json"}:{}),...options.headers}});
  if(response.status===401){window.location.reload();throw new Error("登录已失效")}
  const body=await response.json().catch(()=>({})) as T&{error?:string|{message?:string}};
  if(!response.ok){const message=typeof body.error==="string"?body.error:body.error?.message;throw new Error(message??"操作失败")}
  return body;
}
