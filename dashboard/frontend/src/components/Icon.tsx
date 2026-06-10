import type { CSSProperties } from 'react'

type P = { size?: number; stroke?: string; width?: number; style?: CSSProperties }

function svg(path: React.ReactNode, sw = 1.7) {
  return function Ico({ size = 20, stroke = 'currentColor', width, style }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={stroke}
        strokeWidth={width ?? sw}
        style={style}
      >
        {path}
      </svg>
    )
  }
}

export const Icon = {
  topology: svg(<><circle cx="5.5" cy="12" r="2.5" /><circle cx="18.5" cy="5.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /><path d="M8 11l8-4.3M8 13l8 4.3" /></>),
  deploy: svg(<><path d="M12 3.5l8 4-8 4-8-4 8-4z" /><path d="M4 12l8 4 8-4" /><path d="M4 16.5l8 4 8-4" /></>),
  dashboard: svg(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>),
  scenes: svg(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><circle cx="8" cy="9.5" r="1.6" /><path d="M3.5 17l5-5 3.5 3.5 3-3 5.5 5.5" /></>),
  builder: svg(<><path d="M4 20l3.5-1 9.5-9.5a2 2 0 00-3-3L4.5 16 4 20z" /><path d="M13 6.5l4 4" /></>),
  twin: svg(<><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>),
  runs: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5l6 3.5-6 3.5z" /></>),
  replay: svg(<><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>),
  lake: svg(<><ellipse cx="12" cy="6" rx="7.5" ry="2.8" /><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6" /><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></>),
  servers: svg(<><rect x="4" y="4.5" width="16" height="6.5" rx="1.6" /><rect x="4" y="13" width="16" height="6.5" rx="1.6" /><path d="M7.5 7.75h.01M7.5 16.25h.01M11 7.75h5M11 16.25h5" /></>),
  agents: svg(<><path d="M4 5.5h16v10H9l-5 4z" /><path d="M12 8v4M10 10h4" /></>),
  studio: svg(<><rect x="6.5" y="6.5" width="11" height="11" rx="2.4" /><path d="M9.5 3.5v2M14.5 3.5v2M9.5 18.5v2M14.5 18.5v2M3.5 9.5h2M3.5 14.5h2M18.5 9.5h2M18.5 14.5h2" /><circle cx="12" cy="12" r="2.2" /></>),
  reports: svg(<><path d="M6 3.5h8l4 4V20a.5.5 0 01-.5.5h-11A.5.5 0 016 20z" /><path d="M9 16v-3M12 16v-5M15 16v-2" /></>),
  alerts: svg(<><path d="M6.5 10a5.5 5.5 0 0111 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z" /><path d="M10.2 18.5a2 2 0 003.6 0" /></>),
  admin: svg(<><path d="M12 3l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /><circle cx="12" cy="10" r="2" /><path d="M8.5 16c.6-1.8 2-2.6 3.5-2.6s2.9.8 3.5 2.6" /></>),
  search: svg(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>, 1.9),
  bell: svg(<><path d="M6.5 10a5.5 5.5 0 0111 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z" /><path d="M10.2 18.5a2 2 0 003.6 0" /></>),
  rows: svg(<path d="M4 7h16M4 12h16M4 17h16" />, 1.9),
  chevronDown: svg(<path d="M6 9.5l6 6 6-6" />, 2),
  chevronRight: svg(<path d="M9 6l6 6-6 6" />, 2),
  plus: svg(<path d="M12 5.5v13M5.5 12h13" />, 2.2),
  play: svg(<path d="M9 7.5l7 4.5-7 4.5z" />, 2),
  check: svg(<path d="M6 12.5l4 4 8-8.5" />, 2.4),
  externalLink: svg(<><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5.5a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-13a.5.5 0 01.5-.5H10" /></>, 1.9),
  layers: svg(<><path d="M12 4l8 4-8 4-8-4z" /><path d="M4 12l8 4 8-4M4 16l8 4 8-4" /></>, 1.8),
  gear: svg(<><circle cx="12" cy="12" r="3" /><path d="M12 3.2v2.4M12 18.4v2.4M4.8 7.8l2 1.2M17.2 15l2 1.2M4.8 16.2l2-1.2M17.2 9l2-1.2" /></>),
  tower: svg(<><path d="M12 10v10M8 20l4-10 4 10M6.5 8a7 7 0 0111 0M4 5.5a11 11 0 0116 0" /></>, 1.8),
  phone: svg(<><rect x="7" y="3" width="10" height="18" rx="2.4" /><path d="M11 18h2" /></>, 1.8),
  route: svg(<><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 17c5-1 7-3 8-8" /></>, 1.8),
  cursor: svg(<path d="M6 3.5l12 8-5 1.5-2 5.5z" />, 1.8),
  measure: svg(<><path d="M3 14.5L14.5 3 21 9.5 9.5 21z" /><path d="M8 9l2 2M11 6l2 2M5 12l2 2" /></>, 1.8),
  upload: svg(<path d="M12 16V4M8 7.5L12 4l4 3.5M4 16v3.5h16V16" />, 1.9),
  spinner: svg(<><path d="M12 3v4M12 17v4M4.2 7.6l2.8 2.8M17 13.6l2.8 2.8M3 12h4M17 12h4M4.2 16.4l2.8-2.8M17 10.4l2.8-2.8" /></>, 1.9),
  info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.2v.1" /></>, 1.9),
  logo: svg(<><circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="8.4" /><path d="M12 3.6v3.2M12 17.2v3.2M3.6 12h3.2M17.2 12h3.2" /></>, 1.6),
}
