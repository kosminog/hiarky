interface CardProps {
  title: string;
  subtitle?: string;
}

type BoxProps = { width: number; height: number };

export function Card({ title, subtitle }: CardProps) {
  return <div>{title}</div>;
}

export function Box(props: BoxProps) {
  return <div />;
}

export function Inline({ x, ...rest }: { x: number; y: string }) {
  return <span />;
}

export function FromInterface(props: CardProps) {
  return <p />;
}
