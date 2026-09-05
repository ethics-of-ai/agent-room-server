import { useState, type ReactElement } from "react";

export interface CounterProps {
  label: string;
  initialCount?: number;
}

export function Counter({ label, initialCount = 0 }: CounterProps): ReactElement {
  const [count] = useState(initialCount);
  return <button aria-label={label}>{count}</button>;
}

export const preview = <Counter label="Clicks" initialCount={2} />;
