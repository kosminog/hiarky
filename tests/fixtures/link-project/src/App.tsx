import Header from './components/Header';
import { List } from './components/List';
import { Footer } from './components';
import * as UI from 'ui-kit';
import { Missing } from './nowhere';

export default function App() {
  return (
    <UI.Panel>
      <Header />
      <List />
      <Missing />
      <Footer />
    </UI.Panel>
  );
}
