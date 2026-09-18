interface HeaderProps {
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export default function Header({ title, theme, onToggleTheme }: HeaderProps) {
  return (
    <header>
      <h1>{title}</h1>
      <button onClick={onToggleTheme}>{theme === 'light' ? 'Dark' : 'Light'} mode</button>
    </header>
  );
}
