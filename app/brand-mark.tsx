export default function BrandMark({className}:{className?:string}) {
  return <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
    <rect x="2" y="2" width="60" height="60" rx="17" fill="#2864dd"/>
    <path d="M14 29 32 16l18 13" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M19 28v21h26V28M27 49V36h10v13" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M11 45h9c4 0 7-3 7-7v-2" fill="none" stroke="#71e4bd" strokeWidth="3" strokeLinecap="round"/>
    <circle cx="11" cy="45" r="3.5" fill="#71e4bd"/>
  </svg>;
}
