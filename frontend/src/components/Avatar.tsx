interface Props {
  name: string
  short: string
  color: string
  kind: 'human' | 'ai'
  size?: 'sm' | 'lg'
}

/** AI 用圆角方块，人用圆形，一眼区分人与模型 */
export function Avatar({ name, short, color, kind, size }: Props) {
  return (
    <span className={`av ${kind} ${size ?? ''}`} style={{ background: color }} title={name} aria-hidden>
      {short}
    </span>
  )
}
