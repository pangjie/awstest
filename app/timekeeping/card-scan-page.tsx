"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isValidEmployeeId, sanitizeEmployeeId } from "@/lib/timekeeping/employee-id";
import { timeApi } from "./api";
import { buildDailyTimelineRows, type DailyTimelineRow } from "./daily-timeline";
import type { CardScanEmployeeResponse, ScanResponse } from "./types";
import { WaveChannelTag, WaveTypeTag } from "./wave-display";

type AttendanceAction="sign_in"|"sign_out";
type ScanRegion={scale:number;aspectRatio:number|null;rotation:number};
type CameraCapabilities=MediaTrackCapabilities&{focusMode?:string[];zoom?:{min:number;max:number;step?:number}};
type CameraConstraintSet=MediaTrackConstraintSet&{focusMode?:string;zoom?:number};

const SCAN_INTERVAL_MS=55;
const SCAN_REGIONS:ScanRegion[]=[
  {scale:.55,aspectRatio:1,rotation:0},
  {scale:.82,aspectRatio:1.8,rotation:0},
  {scale:1,aspectRatio:null,rotation:0},
  {scale:.86,aspectRatio:1.8,rotation:Math.PI/15},
  {scale:.86,aspectRatio:1.8,rotation:-Math.PI/15},
];

export default function CardScanPage({portableDevice}:{portableDevice:boolean}){
  const [report,setReport]=useState<CardScanEmployeeResponse|null>(null);
  const [selection,setSelection]=useState<AttendanceAction|null>(null);
  const [cameraOpen,setCameraOpen]=useState(false);
  const [loading,setLoading]=useState(false);
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [now,setNow]=useState(Date.now);
  const videoRef=useRef<HTMLVideoElement>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const scanningRef=useRef(false);
  const scanLoopRef=useRef<number|null>(null);
  const scanTimeoutRef=useRef<number|null>(null);

  const disposeCamera=useCallback(()=>{
    scanningRef.current=false;
    if(scanLoopRef.current!==null){window.clearTimeout(scanLoopRef.current);scanLoopRef.current=null}
    if(scanTimeoutRef.current!==null){window.clearTimeout(scanTimeoutRef.current);scanTimeoutRef.current=null}
    streamRef.current?.getTracks().forEach(track=>track.stop());
    streamRef.current=null;
    if(videoRef.current)videoRef.current.srcObject=null;
  },[]);
  const closeCamera=useCallback(()=>{disposeCamera();setCameraOpen(false)},[disposeCamera]);

  useEffect(()=>{const interval=window.setInterval(()=>setNow(Date.now()),1_000);return()=>window.clearInterval(interval)},[]);
  useEffect(()=>()=>disposeCamera(),[disposeCamera]);

  const loadEmployee=useCallback(async(badge:string)=>{
    setLoading(true);setError("");setNotice("");setSelection(null);
    try{
      const query=new URLSearchParams({badge});
      setReport(await timeApi<CardScanEmployeeResponse>(`/api/v1/timekeeping/card-scan?${query.toString()}`));
    }catch(loadError){setReport(null);setError(loadError instanceof Error?loadError.message:"员工信息读取失败")}
    finally{setLoading(false)}
  },[]);

  const startCamera=useCallback(async()=>{
    if(scanningRef.current||loading||submitting)return;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){setError("摄像头扫描需要使用 HTTPS，并允许浏览器访问摄像头");return}
    setError("");setNotice("");setCameraOpen(true);scanningRef.current=true;
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"user"},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}});
      if(!scanningRef.current){stream.getTracks().forEach(track=>track.stop());return}
      streamRef.current=stream;
      const video=videoRef.current;
      if(!video)throw new Error("摄像头画面尚未准备好");
      video.srcObject=stream;
      await optimizeCameraTrack(stream.getVideoTracks()[0]);
      await video.play();

      const {BarcodeFormat,BrowserMultiFormatReader}=await import("@zxing/browser");
      const reader=new BrowserMultiFormatReader();
      reader.possibleFormats=[BarcodeFormat.QR_CODE,BarcodeFormat.CODE_128];
      const analysisCanvas=document.createElement("canvas");
      const decodeCanvas=document.createElement("canvas");
      let regionIndex=0;
      let recentSharpness=0;

      const scanFrame=()=>{
        if(!scanningRef.current)return;
        if(video.readyState<HTMLMediaElement.HAVE_CURRENT_DATA){scanLoopRef.current=window.setTimeout(scanFrame,SCAN_INTERVAL_MS);return}
        const sharpness=frameSharpness(video,analysisCanvas);
        recentSharpness=Math.max(sharpness,recentSharpness*.96);
        if(sharpness>=6&&sharpness>=recentSharpness*.5){
          drawScanRegion(video,decodeCanvas,SCAN_REGIONS[regionIndex]);
          regionIndex=(regionIndex+1)%SCAN_REGIONS.length;
          try{
            const badge=sanitizeEmployeeId(reader.decodeFromCanvas(decodeCanvas).getText());
            if(isValidEmployeeId(badge)){
              closeCamera();
              void loadEmployee(badge);
              return;
            }
            setError("扫描内容不是有效的员工工卡，请对准员工 ID 条码或二维码");
          }catch{/* 当前区域没有可识别工卡，继续读取下一帧。 */}
        }
        scanLoopRef.current=window.setTimeout(scanFrame,SCAN_INTERVAL_MS);
      };
      scanFrame();
      if(scanningRef.current)scanTimeoutRef.current=window.setTimeout(()=>{closeCamera();setError("未识别到员工工卡，请重新扫描")},30_000);
    }catch(cameraError){
      closeCamera();
      setError(cameraErrorMessage(cameraError));
    }
  },[closeCamera,loadEmployee,loading,submitting]);

  const confirm=useCallback(async()=>{
    if(!report||!selection||submitting)return;
    setSubmitting(true);setError("");setNotice("");
    const label=selection==="sign_in"?"Sign In":"Sign Out";
    try{
      await timeApi<ScanResponse>("/api/v1/timekeeping/card-scan",{method:"POST",body:JSON.stringify({code:selection==="sign_in"?"ACT-CLOCKIN":"ACT-OUT",employeeId:report.snapshot.employee.id,requestId:crypto.randomUUID()})});
      setReport(null);setSelection(null);setNotice(`${label} 已提交，请扫描下一位员工`);
    }catch(submitError){setError(submitError instanceof Error?submitError.message:`${label} 失败`)}
    finally{setSubmitting(false)}
  },[report,selection,submitting]);

  const timelineRows=useMemo(()=>report?buildDailyTimelineRows(report,report.workDate,now):[],[now,report]);
  const onDuty=Boolean(report?.snapshot.shift);

  if(!portableDevice)return <div className="time-page time-card-scan-unavailable"><div><span>▣</span><h2>工卡扫描仅供移动终端使用</h2><p>请使用 iPhone、iPad 或其他带摄像头的触控终端打开本页面。</p></div></div>;

  return <div className="time-page time-card-scan-page" aria-label="工卡扫描">
    <section className={`time-card-camera${cameraOpen?" active":""}`}>
      <div className="time-card-camera-view">
        <video ref={videoRef} autoPlay muted playsInline aria-label="工卡扫描摄像头画面"/>
        {!cameraOpen&&<div className="time-card-camera-placeholder"><span>▣</span><b>{loading?"正在读取员工信息":"点击扫描开启摄像头"}</b></div>}
        {cameraOpen&&<div className="time-card-camera-frame" aria-hidden="true"><i/><i/><i/><i/><span/></div>}
      </div>
      <button type="button" className="time-card-scan-button" disabled={cameraOpen||loading||submitting} onClick={()=>void startCamera()}><span>⌁</span><b>{cameraOpen?"扫描中":"扫描"}</b></button>
    </section>

    <section className="time-card-scan-identity" aria-live="polite">
      <span>姓名</span>
      <strong>{loading?"读取中…":report?.snapshot.employee.name??"尚未识别员工"}</strong>
    </section>

    <section className="time-card-scan-actions" aria-label="考勤操作">
      <button type="button" className={`sign-in${selection==="sign_in"?" selected":""}`} aria-pressed={selection==="sign_in"} disabled={!report||onDuty||report.snapshot.state==="inactive"||submitting} onClick={()=>setSelection("sign_in")}><b>Sign In</b></button>
      <button type="button" className={`sign-out${selection==="sign_out"?" selected":""}`} aria-pressed={selection==="sign_out"} disabled={!report||!onDuty||submitting} onClick={()=>setSelection("sign_out")}><b>Sign Out</b></button>
      <button type="button" className="confirm" disabled={!report||!selection||submitting} onClick={()=>void confirm()}><b>{submitting?"提交中":"Confirm"}</b></button>
    </section>

    {error&&<div className="time-card-scan-message error" role="alert">{error}</div>}
    {notice&&<div className="time-card-scan-message success" role="status">{notice}</div>}

    <section className="time-card-scan-timeline">
      <div><span>当天处理内容</span><b>{report?`${report.workDate} · ${timelineRows.length} 条`:"扫描员工后显示"}</b></div>
      {report?(timelineRows.length?<div className="time-card-scan-timeline-list">{timelineRows.map(row=><MobileTimelineRow key={row.id} row={row}/>)}</div>:<p>今天没有考勤或工作记录</p>):<p>员工的 Sign In、Sign Out 和工作内容会显示在这里</p>}
    </section>
  </div>;
}

function MobileTimelineRow({row}:{row:DailyTimelineRow}){
  return <article className={row.kind}><div><strong>{row.nature}</strong>{row.waveNo&&<code>{row.waveNo}</code>}<time>{row.clock}</time></div><MobileTimelineContent row={row}/>{row.duration&&<b>{row.duration}</b>}</article>;
}

function MobileTimelineContent({row}:{row:DailyTimelineRow}){
  if(!row.project||row.project.workType!=="wave")return <p>{row.content}</p>;
  return <p className="time-card-scan-wave"><span><WaveChannelTag value={row.project.channelName}/><WaveTypeTag value={row.project.channelType}/></span><em>{row.content}</em></p>;
}

function cameraErrorMessage(error:unknown){
  const name=error instanceof DOMException?error.name:"";
  if(name==="NotAllowedError"||name==="SecurityError")return "摄像头权限未开启，请在浏览器设置中允许本网站使用摄像头";
  if(name==="NotFoundError"||name==="OverconstrainedError")return "没有找到可用的摄像头";
  if(name==="NotReadableError"||name==="AbortError")return "摄像头正被其他应用占用，请关闭其他应用后重试";
  return "摄像头启动失败，请检查浏览器权限后重试";
}

async function optimizeCameraTrack(track:MediaStreamTrack|undefined){
  if(!track?.getCapabilities)return;
  const capabilities=track.getCapabilities() as CameraCapabilities;
  const advanced:CameraConstraintSet={};
  if(capabilities.focusMode?.includes("continuous"))advanced.focusMode="continuous";
  if(capabilities.zoom&&capabilities.zoom.max>capabilities.zoom.min){
    const target=Math.min(capabilities.zoom.max,Math.max(capabilities.zoom.min,1.15));
    advanced.zoom=stepAligned(target,capabilities.zoom);
  }
  if(!Object.keys(advanced).length)return;
  try{await track.applyConstraints({advanced:[advanced]})}
  catch{/* 摄像头报告的可选能力在部分浏览器中仍可能拒绝应用，保留默认设置继续扫描。 */}
}

function stepAligned(value:number,range:{min:number;max:number;step?:number}){
  if(!range.step)return value;
  const steps=Math.round((value-range.min)/range.step);
  return Math.min(range.max,Math.max(range.min,range.min+steps*range.step));
}

function frameSharpness(video:HTMLVideoElement,canvas:HTMLCanvasElement){
  const width=128;
  const height=Math.max(72,Math.round(width*video.videoHeight/video.videoWidth));
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  if(!context)return Number.POSITIVE_INFINITY;
  context.drawImage(video,0,0,width,height);
  const pixels=context.getImageData(0,0,width,height).data;
  let sum=0;let squared=0;let count=0;
  for(let y=1;y<height-1;y+=2){
    for(let x=1;x<width-1;x+=2){
      const center=gray(pixels,(y*width+x)*4);
      const laplacian=4*center-gray(pixels,(y*width+x-1)*4)-gray(pixels,(y*width+x+1)*4)-gray(pixels,((y-1)*width+x)*4)-gray(pixels,((y+1)*width+x)*4);
      sum+=laplacian;squared+=laplacian*laplacian;count++;
    }
  }
  const mean=sum/count;
  return squared/count-mean*mean;
}

function gray(pixels:Uint8ClampedArray,index:number){return pixels[index]*.299+pixels[index+1]*.587+pixels[index+2]*.114}

function drawScanRegion(video:HTMLVideoElement,canvas:HTMLCanvasElement,region:ScanRegion){
  const availableWidth=video.videoWidth*region.scale;
  const availableHeight=video.videoHeight*region.scale;
  let sourceWidth=availableWidth;
  let sourceHeight=availableHeight;
  if(region.aspectRatio!==null){
    if(availableWidth/availableHeight>region.aspectRatio)sourceWidth=availableHeight*region.aspectRatio;
    else sourceHeight=availableWidth/region.aspectRatio;
  }
  const sourceX=(video.videoWidth-sourceWidth)/2;
  const sourceY=(video.videoHeight-sourceHeight)/2;
  const scale=Math.min(1024/sourceWidth,1024/sourceHeight);
  const width=Math.max(1,Math.round(sourceWidth*scale));
  const height=Math.max(1,Math.round(sourceHeight*scale));
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext("2d");
  if(!context)return;
  context.imageSmoothingEnabled=region.rotation!==0;
  if(region.rotation!==0)context.imageSmoothingQuality="high";
  context.fillStyle="#fff";context.fillRect(0,0,width,height);
  context.save();context.translate(width/2,height/2);context.rotate(region.rotation);
  context.drawImage(video,sourceX,sourceY,sourceWidth,sourceHeight,-width/2,-height/2,width,height);
  context.restore();
}
