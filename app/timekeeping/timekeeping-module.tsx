"use client";

import type { Dispatch, SetStateAction } from "react";
import type { TimekeepingPageKey } from "@/lib/page-permissions";
import DashboardPage from "./dashboard-page";
import CardScanPage from "./card-scan-page";
import EmployeesPage from "./employees-page";
import RecordsPage from "./records-page";
import ScanPage from "./scan-page";
import type { DashboardFilters, DashboardSortState, EmployeeSortState, ScanWaveSortState } from "./types";

export default function TimekeepingModule({page,titleTarget,isAdmin,initialScanBadge,initialRecordBadge,openScan,openRecords,dashboardDate,dashboardExportStartDate,dashboardExportEndDate,dashboardFilters,setDashboardFilters,dashboardSort,setDashboardSort,dashboardExportKey,dashboardImportOpen,closeDashboardImport,scanSort,setScanSort,employeeSort,setEmployeeSort,portableDevice}:{page:TimekeepingPageKey;titleTarget:HTMLDivElement|null;isAdmin:boolean;initialScanBadge:string;initialRecordBadge:string;openScan?:((badge:string)=>void);openRecords?:((badge:string)=>void);dashboardDate:string;dashboardExportStartDate:string;dashboardExportEndDate:string;dashboardFilters:DashboardFilters;setDashboardFilters:Dispatch<SetStateAction<DashboardFilters>>;dashboardSort:DashboardSortState;setDashboardSort:Dispatch<SetStateAction<DashboardSortState>>;dashboardExportKey:number;dashboardImportOpen:boolean;closeDashboardImport:()=>void;scanSort:ScanWaveSortState;setScanSort:Dispatch<SetStateAction<ScanWaveSortState>>;employeeSort:EmployeeSortState;setEmployeeSort:Dispatch<SetStateAction<EmployeeSortState>>;portableDevice:boolean}){
  switch(page){
    case "time-scan":return <ScanPage titleTarget={titleTarget} initialBadge={initialScanBadge} sortState={scanSort} setSortState={setScanSort}/>;
    case "time-card-scan":return <CardScanPage portableDevice={portableDevice}/>;
    case "time-dashboard":return <DashboardPage date={dashboardDate} exportStartDate={dashboardExportStartDate} exportEndDate={dashboardExportEndDate} filters={dashboardFilters} setFilters={setDashboardFilters} sortState={dashboardSort} setSortState={setDashboardSort} exportKey={dashboardExportKey} importOpen={dashboardImportOpen} closeImport={closeDashboardImport} openScan={openScan}/>;
    case "time-records":return <RecordsPage titleTarget={titleTarget} isAdmin={isAdmin} initialBadge={initialRecordBadge}/>;
    case "time-employees":return <EmployeesPage titleTarget={titleTarget} isAdmin={isAdmin} openScan={openScan} openRecords={openRecords} sortState={employeeSort} setSortState={setEmployeeSort}/>;
  }
}
