"use client";

import type { TimekeepingPageKey } from "@/lib/page-permissions";
import type { DashboardRangeId } from "@/lib/timekeeping/dashboard-range";
import DashboardPage from "./dashboard-page";
import EmployeesPage from "./employees-page";
import RecordsPage from "./records-page";
import ScanPage from "./scan-page";

export default function TimekeepingModule({page,titleTarget,isAdmin,initialScanBadge,initialRecordBadge,openScan,openRecords,dashboardDate,dashboardRange,dashboardExportKey,dashboardImportOpen,closeDashboardImport}:{page:TimekeepingPageKey;titleTarget:HTMLDivElement|null;isAdmin:boolean;initialScanBadge:string;initialRecordBadge:string;openScan?:((badge:string)=>void);openRecords?:((badge:string)=>void);dashboardDate:string;dashboardRange:DashboardRangeId;dashboardExportKey:number;dashboardImportOpen:boolean;closeDashboardImport:()=>void}){
  switch(page){
    case "time-scan":return <ScanPage titleTarget={titleTarget} initialBadge={initialScanBadge}/>;
    case "time-dashboard":return <DashboardPage date={dashboardDate} range={dashboardRange} exportKey={dashboardExportKey} importOpen={dashboardImportOpen} closeImport={closeDashboardImport}/>;
    case "time-records":return <RecordsPage titleTarget={titleTarget} isAdmin={isAdmin} initialBadge={initialRecordBadge}/>;
    case "time-employees":return <EmployeesPage titleTarget={titleTarget} isAdmin={isAdmin} openScan={openScan} openRecords={openRecords}/>;
  }
}
