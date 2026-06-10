export function Sparkline({
  points,
  color = '#327985',
  height = 34,
}: {
  points: string
  color?: string
  height?: number
}) {
  return (
    <svg
      viewBox="0 0 240 40"
      preserveAspectRatio="none"
      style={{ display: 'block', width: '100%', height, marginTop: 8 }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
