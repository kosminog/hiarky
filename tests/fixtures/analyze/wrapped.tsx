import { memo, forwardRef } from 'react';

export const Fancy = memo(({ a }: { a: number }) => <div>{a}</div>);

export const WithRef = forwardRef((props: { b: string }, ref) => <input />);

export const Both = memo(forwardRef(() => <span />));
