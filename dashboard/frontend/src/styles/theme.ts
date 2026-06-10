export const color = {
  appBg: '#EEF3F4',
  surface: '#FFFFFF',
  surfaceMuted: '#F3F7F8',
  surfaceSubtle: '#F7FAFA',
  border: '#E2E9EA',
  borderSoft: '#E7EEEF',
  borderFaint: '#EDF2F3',
  divider: '#F1F5F6',

  ink: '#0E1820',
  inkStrong: '#0C2125',
  textMuted: '#5B6E77',
  textSubtle: '#6D8E99',
  textFaint: '#84969E',
  textGhost: '#9AAAB1',

  brand: '#327985',
  brandDeep: '#275578',
  brandBright: '#6093BA',
  brandTint: '#E6EFF0',
  brandBorder: '#C2D7DA',

  ok: '#327985',
  okFg: '#327985',
  okBg: '#E6EFF0',
  warn: '#B07908',
  warnFg: '#A56C08',
  warnBg: '#FDF1DF',
  danger: '#B3272C',
  dangerFg: '#D13B40',
  dangerBg: '#FDECEC',
  idle: '#6D8E99',
  idleBg: '#F1F5F6',
  neutralFg: '#3B4C54',
  neutralBg: '#EEF3F4',

  chartGreen: '#327985',
  chartBlue: '#6093BA',
  chartAmber: '#D86993',
  inverse: '#C2410C',
} as const

export const tone = {
  ok: { fg: '#327985', bg: '#E6EFF0' },
  neutral: { fg: '#3B4C54', bg: '#EEF3F4' },
  warn: { fg: '#B07908', bg: '#FDF1DF' },
  danger: { fg: '#B3272C', bg: '#FDECEC' },
  idle: { fg: '#6D8E99', bg: '#F1F5F6' },
} as const

export const font = {
  sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  label: "'Manrope', system-ui, -apple-system, sans-serif",
  display: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
} as const

export const radius = {
  sm: '8px',
  md: '11px',
  lg: '14px',
  xl: '16px',
  pill: '999px',
} as const

export const sinrRamp =
  'linear-gradient(90deg,#528FBD,#3EA7BA,#4FBF7B,#E9C43C,#E5713D,#D8433F)'

export const palette = {
  steel: '#6093BA', navy: '#275578', greyTeal: '#6D8E99',
  teal: '#327985', pink: '#EA9EBF', rose: '#D86993',
} as const

export const pageGround = 'linear-gradient(180deg, #E8EFF5 0%, #EEF3F7 55%, #F5EFF3 100%)'

export const heroGround =
  'radial-gradient(1000px 520px at 88% -12%, rgba(96,147,186,.30), transparent 62%), ' +
  'radial-gradient(900px 520px at -4% 108%, rgba(234,158,191,.34), transparent 60%), ' + pageGround
