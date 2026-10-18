"use client";

import { t } from "@/app/ui-language";
import type { StatisticsResult } from "@/lib/timekeeping/statistics";

const colors=["#3976d5","#21a6a1","#8863c9","#e6a23b","#4b9b68","#d57887","#99a8bc"];
export const projectColor=(index:number)=>colors[index%colors.length];

export default function StatisticsPie({projects,total}:{projects:StatisticsResult["projects"];total:number}){
  const entries=projects.map((p,i)=>({name:p.name,ms:p.ms,color:projectColor(i)}));
  const remainder=Math.max(0,total-entries.reduce((sum,p)=>sum+p.ms,0));
  if(remainder>0)entries.push({name:"未归类在岗时间",ms:remainder,color:"#d4dce6"});
  const visible=entries.filter(p=>p.ms>0&&total>0);
  const slices=visible.map((p,index)=>{
    const start=-Math.PI/2+visible.slice(0,index).reduce((sum,item)=>sum+item.ms,0)/total*Math.PI*2,sweep=p.ms/total*Math.PI*2;
    const mid=start+sweep/2;
    return {...p,start,end:start+sweep,sweep,mid,side:Math.cos(mid)>=0?1:-1,labelY:0};
  });
  const left=slices.filter(p=>p.side<0).sort((a,b)=>Math.sin(a.mid)-Math.sin(b.mid));
  const right=slices.filter(p=>p.side>0).sort((a,b)=>Math.sin(a.mid)-Math.sin(b.mid));
  const height=Math.max(260,Math.max(left.length,right.length)*28+24),cy=height/2,cx=320,r=100;
  // Keep every label outside the pie, with fixed separation even for tiny adjacent slices.
  for(const side of [left,right])side.forEach((p,i)=>{p.labelY=cy+(i-(side.length-1)/2)*28});
  return <figure className="stats-project-chart">
    <svg className="stats-pie-svg" viewBox={`0 0 640 ${height}`} role="img" aria-label={total>0?slices.map(p=>`${t(p.name)} ${(p.ms/total*100).toFixed(1)}%`).join("，"):t("暂无记录")}>
      {!slices.length&&<circle cx={cx} cy={cy} r={r} fill="#e8edf3"/>}
      {slices.map(p=>{
        const dx=Math.cos(p.mid)*6,dy=Math.sin(p.mid)*6;
        const x1=cx+r*Math.cos(p.start),y1=cy+r*Math.sin(p.start),x2=cx+r*Math.cos(p.end),y2=cy+r*Math.sin(p.end);
        const path=`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${p.sweep>Math.PI?1:0} 1 ${x2} ${y2} Z`;
        const anchorX=cx+(r+6)*Math.cos(p.mid),anchorY=cy+(r+6)*Math.sin(p.mid),elbowX=cx+p.side*132,labelX=cx+p.side*148;
        const name=t(p.name),label=name.length>12?name.slice(0,11)+"…":name;
        const percentage=p.ms/total*100,display=percentage<0.1?"<0.1%":`${percentage.toFixed(1)}%`;
        return <g key={p.name} className="stats-pie-slice">
          <title>{name} · {display}</title>
          <g transform={`translate(${dx} ${dy})`} fill={p.color} stroke="#fff" strokeWidth="2" strokeLinejoin="round">
            {p.sweep>=Math.PI*2-1e-10?<circle cx={cx} cy={cy} r={r}/>:<path d={path}/>}
          </g>
          <polyline points={`${anchorX},${anchorY} ${elbowX},${p.labelY} ${labelX-p.side*5},${p.labelY}`} fill="none" stroke={p.color} strokeWidth="1.5"/>
          <circle cx={anchorX} cy={anchorY} r="2.5" fill={p.color}/>
          <text x={labelX} y={p.labelY} dominantBaseline="middle" textAnchor={p.side>0?"start":"end"} className="stats-pie-label">
            <tspan>{label} </tspan><tspan className="stats-pie-percent">{display}</tspan>
          </text>
        </g>;
      })}
    </svg>
  </figure>;
}
