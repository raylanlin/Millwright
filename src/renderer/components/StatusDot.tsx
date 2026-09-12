// src/renderer/components/StatusDot.tsx

interface Props {
  connected: boolean;
  size?: number;
  /** P130: a tool is currently executing on the sidecar's single COM thread. Show amber
   *  with a tooltip naming the running tool; do not flicker red/green. */
  busy?: boolean;
  runningTool?: string;
}

export function StatusDot({ connected, size = 7, busy = false, runningTool }: Props) {
  // P130: amber for "工具执行中" beats the green/red flicker of polling a single-thread
  // executor (the probe would otherwise flip every cycle).
  const color = busy ? '#e8a23a' : connected ? '#4caf72' : '#d45454';
  const shadow = busy ? '#e8a23a66' : connected ? '#4caf7266' : '#d4545466';
  return (
    <span
      title={busy ? `工具执行中：${runningTool ?? ''}` : undefined}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 4px ${shadow}`,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}
