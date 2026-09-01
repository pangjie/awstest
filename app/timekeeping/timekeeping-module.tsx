"use client";

import type { Dispatch, SetStateAction } from "react";
import type { TimekeepingPageKey } from "@/lib/page-permissions";
import DashboardPage from "./dashboard-page";
import CardScanPage from "./card-scan-page";
import EmployeesPage from "./employees-page";
import RecordsPage from "./records-page";
import ScanPage from "./scan-page";
import type { DashboardFilters, EmployeeSortState } from "./types";

export default function TimekeepingModule({page,titleTarget,isAdmin,initialScanBadge,initialRecordBadge,openScan,openRecords,dashboardDate,dashboardExportStartDate,dashboardExportEndDate,dashboardFilters,setDashboardFilters,dashboardExportKey,dashboardImportOpen,closeDashboardImport,employeeSort,setEmployeeSort,portableDevice}:{page:TimekeepingPageKey;titleTarget:HTMLDivElement|null;isAdmin:boolean;initialScanBadge:string;initialRecordBadge:string;openScan?:((badge:string)=>void);openRecords?:((badge:string)=>void);dashboardDate:string;dashboardExportStartDate:string;dashboardExportEndDate:string;dashboardFilters:DashboardFilters;setDashboardFilters:Dispatch<SetStateAction<DashboardFilters>>;dashboardExportKey:number;dashboardImportOpen:boolean;closeDashboardImport:()=>void;employeeSort:EmployeeSortState;setEmployeeSort:Dispatch<SetStateAction<EmployeeSortState>>;portableDevice:boolean}){
  switch(page){
    case "time-scan":return <ScanPage titleTarget={titleTarget} initialBadge={initialScanBadge}/>;
    case "time-card-scan":return <CardScanPage portableDevice={portableDevice}/>;
    case "time-dashboard":return <DashboardPage date={dashboardDate} exportStartDate={dashboardExportStartDate} exportEndDate={dashboardExportEndDate} filters={dashboardFilters} setFilters={setDashboardFilters} exportKey={dashboardExportKey} importOpen={dashboardImportOpen} closeImport={closeDashboardImport} openScan={openScan}/>;
    case "time-records":return <RecordsPage titleTarget={titleTarget} isAdmin={isAdmin} initialBadge={initialRecordBadge}/>;
    case "time-employees":return <EmployeesPage titleTarget={titleTarget} isAdmin={isAdmin} openScan={openScan} openRecords={openRecords} sortState={employeeSort} setSortState={setEmployeeSort}/>;
  }
}
