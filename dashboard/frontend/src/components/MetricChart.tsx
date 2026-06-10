const H_VIEW = 150
const H_PX = 190

function lastY(points: string): number {
  const last = String(points || '').trim().split(/\s+/).pop() || '0,75'
  const y = parseFloat(last.split(',')[1])
  return isNaN(y) ? H_VIEW / 2 : y
}

export function MetricChart({
  title,
  subtitle = '',
  value,
  delta = '',
  deltaColor = '#6D8E99',
  color = '#327985',
  points,
  secondaryPoints,
  yLabels = [],
  axis = [],
}: {
  title: string
  subtitle?: string
  value: string
  delta?: string
  deltaColor?: string
  color?: string
  points: string
  secondaryPoints?: string
  yLabels?: string[]
  axis?: string[]
}) {
  const dot = Math.round((lastY(points) / H_VIEW) * H_PX) - 5
  const areaPoints = points ? `${points} 600,150 0,150` : ''

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #E2E9EA',
        borderRadius: 16,
        padding: '20px 22px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
          <div style={{ fontSize: 12.5, color: '#6D8E99', fontWeight: 600, marginTop: 3 }}>
            {subtitle}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.8px' }}>{value}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: deltaColor }}>{delta}</div>
        </div>
      </div>

      <div style={{ position: 'relative', paddingLeft: 48, marginTop: 14 }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: H_PX,
            width: 42,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            fontSize: 10.5,
            color: '#A9B7BD',
            fontWeight: 600,
          }}
        >
          {yLabels.map((y, i) => (
            <span key={i}>{y}</span>
          ))}
        </div>
        <svg viewBox="0 0 600 150" preserveAspectRatio="none" style={{ width: '100%', height: H_PX, display: 'block' }}>
          {[0, 37.5, 75, 112.5, 150].map((y) => (
            <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#EFF4F5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {areaPoints && <polygon points={areaPoints} fill={color} opacity={0.09} />}
          <polyline points={points} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" />
          {secondaryPoints && (
            <polyline points={secondaryPoints} fill="none" stroke="#D86993" strokeWidth="2" strokeDasharray="5 4" />
          )}
        </svg>
        <span
          style={{
            position: 'absolute',
            right: -3,
            width: 9,
            height: 9,
            borderRadius: '50%',
            boxShadow: '0 0 0 2.5px #fff',
            background: color,
            top: dot,
          }}
        />
        <span
          style={{
            position: 'absolute',
            right: 12,
            background: '#fff',
            border: '1px solid #E7EEEF',
            borderRadius: 7,
            padding: '3px 9px',
            fontSize: 11.5,
            fontWeight: 800,
            color,
            top: Math.max(dot - 30, 0),
          }}
        >
          {value}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11.5,
          color: '#9AAAB1',
          fontWeight: 600,
          padding: '6px 0 0 48px',
          borderTop: '1px solid #F1F5F6',
          marginTop: 6,
        }}
      >
        {axis.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  )
}
