// src/renderer/components/StatusDot.tsx

interface Props {
  connected: boolean;
  size?: number;
}

export function StatusDot({ connected, size = 7 }: Props) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: connected ? '#4caf72' : '#d45454',
        boxShadow: connected ? '0 0 4px #4caf7266' : '0 0 4px #d4545466',
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}
