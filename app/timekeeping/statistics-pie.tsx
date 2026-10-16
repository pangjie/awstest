"use client";

import { t } from "@/app/ui-language";
import type { StatisticsResult } from "@/lib/timekeeping/statistics";

const colors=["#3976d5","#21a6a1","#8863c9","#e6a23b","#4b9b68","#d57887","#99a8bc"];
export const projectColor=(index:number)=>colors[index%colors.length];

export default function StatisticsPie({projects,total}:{projects:StatisticsResult["projects"];total:number}){
  const entries=projects.map((p,i)=>({name:p.name,ms:p.ms,color:projectColor(i)}));
  const remainder=Math.max(0,total-entries.reduce((sum,p)=>sum+p.ms,0));
  if(remainder>0)entries.push({name:"未归类在岗时间",ms:remainder,color:"#d4dce6"});
  let offset=0;
  const slices=entries.filter(p=>p.ms>0).map(p=>{
    const start=offset;offset+=total>0?p.ms/total*100:0;
    return `${p.color} ${start}% ${offset}%`;
  });
  return <figure className="stats-project-chart">
    <div className="stats-pie-content">
      <div className="stats-pie" role="img" aria-label={total>0?entries.filter(p=>p.ms>0).map(p=>`${t(p.name)} ${(p.ms/total*100).toFixed(1)}%`).join("，"):t("暂无记录")} style={{background:total>0&&slices.length?`conic-gradient(${slices.join(",")})`:"#e8edf3"}}/>
    </div>
  </figure>;
}
