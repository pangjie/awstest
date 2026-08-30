import type { CSSProperties } from "react";
import { normalizeWorkType, WAVE_TYPE_DEFINITIONS } from "@/lib/timekeeping/waves";

const CHANNEL_COLORS:Record<string,CSSProperties>={
  usps:{backgroundColor:"#e9edff",borderColor:"#aeb9e6",color:"#354b9a"},
  swiftx:{backgroundColor:"#e2f5fa",borderColor:"#8bc7d4",color:"#126a7c"},
  gofo:{backgroundColor:"#e6f5ea",borderColor:"#a7d5b4",color:"#267044"},
  cbt:{backgroundColor:"#fff1dc",borderColor:"#e4c184",color:"#8d5a12"},
  cbs:{backgroundColor:"#f1eaff",borderColor:"#c5b2e4",color:"#67439a"},
  speedx:{backgroundColor:"#ffede5",borderColor:"#e5b29d",color:"#914526"},
  ups:{backgroundColor:"#f5eddf",borderColor:"#d5bd93",color:"#765426"},
  fedex:{backgroundColor:"#eee9fa",borderColor:"#bdb0dc",color:"#624592"},
  yanwen:{backgroundColor:"#fdebf2",borderColor:"#dfacc0",color:"#94405f"},
  uniuni:{backgroundColor:"#fdebea",borderColor:"#ddaead",color:"#963f3d"},
  普通:{backgroundColor:"#edf1f5",borderColor:"#c7d0db",color:"#4f6074"},
  其他:{backgroundColor:"#f6f7f9",borderColor:"#d3d9e1",color:"#4f5d70"},
};

export function channelLabel(value:string){return value.trim()||"其他"}

export function waveTypeInfo(value:string){
  const label=normalizeWorkType(value)||"未标注";
  const definition=WAVE_TYPE_DEFINITIONS.find(item=>item.name===label);
  return {label,short:definition?.short??label.slice(0,1),key:definition?.key??"unmarked"};
}

export function WaveChannelTag({value}:{value:string}){
  const label=channelLabel(value);
  const style=CHANNEL_COLORS[label.toLowerCase().replace(/\s+/g,"")];
  return <span className={`time-channel-label${style?"":" unknown"}`} style={style}>{label}</span>;
}

export function WaveTypeTag({value}:{value:string}){
  const type=waveTypeInfo(value);
  return <span className={`time-wave-type ${type.key}`} title={type.label}><span>{type.short}</span></span>;
}
