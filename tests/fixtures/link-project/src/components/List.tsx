import Item from './Item';

export function List({ depth }: { depth: number }) {
  return (
    <ul>
      <Item />
      {depth > 0 && <List depth={depth - 1} />}
    </ul>
  );
}
