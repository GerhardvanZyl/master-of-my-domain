import { useEffect, useState } from "react";

/**
 * Value that only settles after `ms` of quiet. Used for filter inputs that fire
 * in bursts (text typing, slider drags) so the ~290-card filter+sort+render pass
 * runs once per pause instead of once per keystroke/tick.
 *
 * ponytail: trailing edge only — no leading/maxWait. Add them if a filter ever
 * needs to feel instant on the first change.
 */
export function useDebounced<T>(value: T, ms = 150): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
