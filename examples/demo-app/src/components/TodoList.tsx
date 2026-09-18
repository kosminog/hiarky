import { useState, useMemo } from 'react';
import { TodoItem } from './TodoItem';
import { AddTodo } from './AddTodo';

export function TodoList({ user, compact }: { user: string | null; compact?: boolean }) {
  const [todos, setTodos] = useState<string[]>([]);
  const [filter, setFilter] = useState('all');
  const visible = useMemo(() => todos, [todos, filter]);

  return (
    <>
      <AddTodo onAdd={text => setTodos(ts => [...ts, text])} />
      <ul>
        {visible.map((text, i) => (
          <TodoItem key={i} text={text} onRemove={() => setTodos(ts => ts.filter((_, j) => j !== i))} />
        ))}
      </ul>
    </>
  );
}
