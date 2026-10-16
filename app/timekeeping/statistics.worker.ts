import { computeStatistics, type StatsInput } from "@/lib/timekeeping/statistics";

self.onmessage=(event:MessageEvent<StatsInput>)=>{
  try{self.postMessage({result:computeStatistics(event.data)})}
  catch(error){self.postMessage({error:error instanceof Error?error.message:"统计计算失败"})}
};
