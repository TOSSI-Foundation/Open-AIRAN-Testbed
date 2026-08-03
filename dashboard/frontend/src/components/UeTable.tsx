const COLS = '120px 150px 190px 110px 190px 130px 130px 120px 1fr 50px'

export function UeTable({ rows }: { rows: any[] }) {
  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          padding: '11px 22px',
          background: '#F7FAFA',
          borderTop: '1px solid #EDF2F3',
          borderBottom: '1px solid #EDF2F3',
          fontSize: 12.5,
          fontWeight: 700,
          color: '#6D8E99',
        }}
      >
        <span>UE ID</span><span>Status</span><span>Cell ID</span><span>SINR (dB)</span>
        <span>Throughput (DL / UL)</span><span>Latency (ms)</span><span>Speed (km/h)</span>
        <span>Slice</span><span>Location</span><span />
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          style={{
            display: 'grid',
            gridTemplateColumns: COLS,
            alignItems: 'center',
            borderBottom: '1px solid #F1F5F6',
            padding: '15px 22px',
            fontSize: '14px',
          }}
        >
          <span className="sk-mono" style={{ fontWeight: 700 }}>{row.id}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, color: row.stateColor }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: row.stateColor }} />
            {row.state}
          </span>
          <span className="sk-mono" style={{ color: '#3B4C54' }}>{row.cell}</span>
          <span style={{ fontWeight: 600, color: row.sinrColor }}>{row.sinr}</span>
          <span style={{ color: '#3B4C54' }}>{row.tput}</span>
          <span style={{ color: '#3B4C54' }}>{row.latency}</span>
          <span style={{ color: '#3B4C54' }}>{row.speed}</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#3B4C54' }}>{row.slice}</span>
          <span style={{ color: '#5B6E77', fontSize: 13.5 }}>{row.loc}</span>
          <span style={{ color: '#A3B2B8', fontWeight: 700, textAlign: 'right', cursor: 'pointer' }}>⋮</span>
        </div>
      ))}
    </>
  )
}
