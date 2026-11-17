'use strict';
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const node = id => document.getElementById(id);
  const render = state => {
    node('message').textContent = state.message || '正在准备应用…';
    node('detail').textContent = state.detail || '';
    node('version').textContent = state.version ? '业务版本 ' + state.version : '';
    const progress = node('progress');
    if (Number.isFinite(state.percent)) progress.value = Math.max(0, Math.min(100, state.percent));
    else progress.removeAttribute('value');
    progress.hidden = state.status === 'blocked';
    node('retry').hidden = state.status !== 'blocked';
    node('quit').hidden = state.status !== 'blocked';
    node('status').setAttribute('aria-busy', String(state.status !== 'blocked'));
  };
  ipcRenderer.on('business-startup:state', (_event, state) => render(state));
  ipcRenderer.invoke('business-startup:state').then(render).catch(() => {});
  node('retry').addEventListener('click', () => {
    node('retry').disabled = true;
    ipcRenderer.invoke('business-startup:retry').catch(() => {}).finally(() => { node('retry').disabled = false; });
  });
  node('quit').addEventListener('click', () => { ipcRenderer.invoke('business-startup:quit').catch(() => {}); });
});
