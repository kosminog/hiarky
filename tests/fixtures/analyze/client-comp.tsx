'use client';

import { track } from './analytics';

export function Widget({ id }: { id: string }) {
  track(id);
  return <div>{id}</div>;
}
