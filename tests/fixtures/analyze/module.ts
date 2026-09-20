import { z } from 'zod';
import { helper } from './helper';

export interface Options {
  retries: number;
  timeout: number;
}

export type Mode = 'fast' | 'slow';

export enum Level {
  Low,
  High,
}

export const LIMITS = { max: 10, min: 1 };

export const schema = z.object({ id: z.string() });

export function run(input: string, opts: Options): Promise<void> {
  const inner = () => helper(input);
  return Promise.resolve(inner());
}

export class Service {
  url = '';
  start() {
    return run('x', { retries: 1, timeout: 2 });
  }
}

function privateHelper() {
  return 1;
}
