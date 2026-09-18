// Точка входа окна приложения внутри презентации.
// Здесь запускается тот же самый App, что и в рабочем клиенте, только сервер
// подставной, а команды приходят из дека.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { installStorage, installFetch, installUpload, installWebSocket, installMedia, bus, ready, report } from './bridge';
import { runCommand } from './director';
import App from '../../../src/renderer/src/App';
import '../../../src/renderer/src/styles/theme.css';
import './frame.css';

const boot = window.__OMC__ || {};

installStorage(boot.storage || {});
installFetch();
installUpload();
installWebSocket();
installMedia();

document.documentElement.dataset.theme = boot.theme || 'light';

bus.onCommand = async (m) => {
  try {
    await runCommand(m.cmd);
    report({ id: m.id, ok: true });
  } catch (err) {
    report({ id: m.id, ok: false, error: String(err.message || err) });
  }
};

bus.onScene = (m) => {
  if (m.theme) document.documentElement.dataset.theme = m.theme;
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
ready(boot.role || 'user');
