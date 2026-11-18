'use strict';
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const node = id => document.getElementById(id);
  const render = state => {
    const blocked = state.status === 'blocked';
    document.body.classList.toggle('blocked', blocked);
    node('message').textContent = blocked ? state.message || '暂时无法进入应用' : state.status === 'downloading' ? '正在更新…' : '正在启动…';
    node('detail').textContent = blocked ? state.detail || '' : '';
    node('detail').hidden = !blocked;
    node('close').hidden = blocked;
    node('actions').hidden = !blocked;
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
  node('close').addEventListener('click', () => { ipcRenderer.invoke('business-startup:quit').catch(() => {}); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') ipcRenderer.invoke('business-startup:quit').catch(() => {}); });
});
