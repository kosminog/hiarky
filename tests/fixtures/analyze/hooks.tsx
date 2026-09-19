import React, { useReducer, useRef } from 'react';
import { useQuery } from 'some-lib';

const reducer = (s: unknown) => s;
const ThemeContext = React.createContext<string | null>(null);

export function Dashboard() {
  const [state, dispatch] = useReducer(reducer, {});
  const box = useRef(null);
  const { data, error } = useQuery('key');
  const theme = React.useContext(ThemeContext);
  React.useEffect(() => {}, []);
  return <div />;
}
