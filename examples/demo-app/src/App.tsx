import { useState, useEffect } from 'react';
import { BrowserRouter, Route } from 'react-router-dom';
import Header from './components/Header';
import { TodoList } from './components/TodoList';
import Footer from './components/Footer';

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  return (
    <BrowserRouter>
      <Header title="Todos" theme={theme} onToggleTheme={() => setTheme(t => (t === 'light' ? 'dark' : 'light'))} />
      <Route path="/" element={<TodoList user={user} />} />
      <Footer />
    </BrowserRouter>
  );
}
