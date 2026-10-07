import { useEffect, useRef } from 'react';

type Fn = (t: number) => void;
const subs = new Set<Fn>();
let running = false;

function loop(t: number) {
  subs.forEach((f) => {
    try {
      f(t);
    } catch (e) {
      console.error(e);
    }
  });
  if (subs.size) requestAnimationFrame(loop);
  else running = false;
}

export function subscribeTick(fn: Fn) {
  subs.add(fn);
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
  return () => {
    subs.delete(fn);
  };
}

/** runs `fn` every animation frame (latest closure is used) */
export function useTick(fn: Fn, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return subscribeTick((t) => ref.current(t));
  }, [enabled]);
}
