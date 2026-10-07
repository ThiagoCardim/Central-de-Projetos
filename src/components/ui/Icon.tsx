// Conjunto de ícones outline (traço 1.75, cantos arredondados) — um único estilo.
import type { SVGProps } from "react";

const PATHS = {
  home: <><path d="M4 10.5 12 4l8 6.5" /><path d="M6 9v10h4.5v-5h3v5H18V9" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  briefcase: <><rect x="3.5" y="7.5" width="17" height="12" rx="2" /><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5" /><path d="M3.5 12.5h17" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  users: <><circle cx="9" cy="9" r="3.25" /><path d="M3.5 19c.6-3 2.8-4.75 5.5-4.75S13.9 16 14.5 19" /><path d="M15 5.9a3.25 3.25 0 0 1 0 6.2M17 14.6c1.8.6 3 2.1 3.5 4.4" /></>,
  shield: <><path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  inbox: <><path d="M4 13.5 6.2 6a1.5 1.5 0 0 1 1.4-1h8.8a1.5 1.5 0 0 1 1.4 1l2.2 7.5" /><path d="M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5h-4.5l-1 2h-5l-1-2z" /></>,
  layers: <><path d="m12 4 8.5 4.5L12 13 3.5 8.5z" /><path d="m3.5 12.5 8.5 4.5 8.5-4.5" /><path d="m3.5 16.5 8.5 4.5 8.5-4.5" /></>,
  building: <><path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20" /><path d="M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9" /><path d="M3.5 20h17M8.5 8h3M8.5 11.5h3M8.5 15h3" /></>,
  chart: <><path d="M4 20h16" /><path d="M7 16.5V11M12 16.5V7M17 16.5v-3.5" /></>,
  logout: <><path d="M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 8 6 12l4 4M6 12h9" /></>,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m19.5 19.5-4.2-4.2" /></>,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  check: <path d="m5.5 12.5 4.5 4.5 8.5-9" />,
  checkCircle: <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.3 2.4 2.4 4.6-4.9" /></>,
  alert: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4M12 17v.01" /></>,
  alertCircle: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.5M12 15.75v.01" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pause: <><circle cx="12" cy="12" r="8.5" /><path d="M10 9v6M14 9v6" /></>,
  userPlus: <><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 19.5c.7-3.3 3.3-5.25 6.5-5.25 1.4 0 2.6.35 3.6 1" /><path d="M18 13v6M15 16h6" /></>,
  userX: <><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 19.5c.7-3.3 3.3-5.25 6.5-5.25 1.4 0 2.6.35 3.6 1" /><path d="m16 14 4 4M20 14l-4 4" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  mapPin: <><path d="M12 20.5s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0c0 4.9-6.5 10.5-6.5 10.5z" /><circle cx="12" cy="10" r="2.25" /></>,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  zap: <path d="M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z" />,
  bell: <><path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  edit: <><path d="M15.5 5.5 18.5 8.5 9 18H6v-3z" /><path d="m13.5 7.5 3 3" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 0 1-13.4 4.6" /><path d="M4.5 12a7.5 7.5 0 0 1 13.4-4.6" /><path d="M18.5 3.5v4h-4M5.5 20.5v-4h4" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.75" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  flag: <><path d="M5.5 20.5V4.5" /><path d="M5.5 5h11l-2 4 2 4h-11" /></>,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.75" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5c.8-3.3 3.6-5.25 7-5.25s6.2 1.95 7 5.25" /></>,
  more: <><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  parallel: <><path d="M7 4v16M17 4v16" /><path d="M4 8h6M14 8h6" /></>,
  sequence: <><path d="M12 4v13" /><path d="m7 12 5 5 5-5" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      width={size} height={size} className={className ?? "icon"} {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
