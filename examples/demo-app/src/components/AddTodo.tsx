import { useState, useRef } from 'react';

export function AddTodo({ onAdd }: { onAdd: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form onSubmit={e => { e.preventDefault(); onAdd(draft); setDraft(''); }}>
      <input ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} />
      <button type="submit">Add</button>
    </form>
  );
}
