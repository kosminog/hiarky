export const TodoItem = ({ text, onRemove }: { text: string; onRemove: () => void }) => (
  <li>
    {text}
    <button onClick={onRemove}>x</button>
  </li>
);
