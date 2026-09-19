import { ThemeContext } from './ctx';

export function Provider({ children }) {
  return <ThemeContext.Provider value="dark">{children}</ThemeContext.Provider>;
}
