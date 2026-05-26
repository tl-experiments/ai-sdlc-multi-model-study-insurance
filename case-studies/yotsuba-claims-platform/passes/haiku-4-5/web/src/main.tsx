// Single-wrap, no StrictMode (StrictMode double-invokes initAuth in dev and
// races with the auth probe).
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
