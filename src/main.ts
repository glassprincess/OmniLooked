import './styles.css';
import { mountApp } from './ui/app';
import { initTheme } from './ui/theme';

initTheme();
const root = document.getElementById('app');
if (root) mountApp(root);
