/**
 * Sleepwalker - shelf.js
 * Controller for extension-origin shelf.html (Route A Document Shelf Setup).
 */
(function () {
  'use strict';

  const statusBox = document.getElementById('shelf-status-box');
  const connectBtn = document.getElementById('btn-connect-shelf');
  const reauthBtn = document.getElementById('btn-reauth-shelf');
  const disconnectBtn = document.getElementById('btn-disconnect-shelf');
  const fileList = document.getElementById('shelf-file-list');
  const countEl = document.getElementById('shelf-count');

  const dbApi = window.SleepwalkerShelfDB;
  let currentRecord = null;

  function setStatus(text, kind = '') {
    if (!statusBox) return;
    statusBox.textContent = text;
    statusBox.className = kind ? `status ${kind}` : 'status';
  }

  function renderFileNames(names) {
    if (!fileList || !countEl) return;
    fileList.textContent = '';
    const safeNames = Array.isArray(names) ? names : [];
    countEl.textContent = String(safeNames.length);
    if (safeNames.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No files visible in this folder (or folder not connected).';
      fileList.appendChild(li);
      return;
    }
    safeNames.forEach((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      fileList.appendChild(li);
    });
  }

  async function refreshView() {
    if (!dbApi) {
      setStatus('Shelf storage module failed to load.', 'err');
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      setStatus('Document Shelf requires Chrome/Edge File System Access API (unavailable here). Standard Choose File on forms still works.', 'warn');
      if (connectBtn) connectBtn.disabled = true;
      return;
    }

    try {
      currentRecord = await dbApi.loadDirectoryRecord();
    } catch (err) {
      setStatus(`Could not inspect IndexedDB shelf: ${err.message}`, 'err');
      return;
    }

    if (!currentRecord || !currentRecord.dirHandle) {
      setStatus('No Document Shelf folder connected yet. Click "Connect Document Folder" above.', '');
      if (reauthBtn) reauthBtn.hidden = true;
      if (disconnectBtn) disconnectBtn.hidden = true;
      renderFileNames([]);
      return;
    }

    const perm = await dbApi.checkHandlePermission(currentRecord.dirHandle, { requestIfPrompt: false });
    if (perm === 'granted') {
      try {
        const entries = await dbApi.collectHandleFiles(currentRecord.dirHandle, 200);
        setStatus(`Connected to "${currentRecord.folderName}" (${entries.length} files ready for hands-free voice upload).`, 'ok');
        if (reauthBtn) reauthBtn.hidden = true;
        if (disconnectBtn) disconnectBtn.hidden = false;
        renderFileNames(entries.map((e) => e.path || e.name));
      } catch (err) {
        setStatus(`Connected handle for "${currentRecord.folderName}" failed to read: ${err.message}`, 'err');
      }
      return;
    }

    setStatus(`Folder "${currentRecord.folderName}" needs re-authorization after browser restart. Click "Re-allow Folder Access".`, 'warn');
    if (reauthBtn) reauthBtn.hidden = false;
    if (disconnectBtn) disconnectBtn.hidden = false;
    renderFileNames([]);
  }

  async function connectWithHandle(dirHandle) {
    if (!dirHandle || !dbApi) return { ok: false };
    await dbApi.saveDirectoryHandle(dirHandle);
    await refreshView();
    return { ok: true, folderName: dirHandle.name || 'Document Shelf' };
  }

  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      if (typeof window.showDirectoryPicker !== 'function') {
        setStatus('showDirectoryPicker is unavailable in this browser context.', 'err');
        return;
      }
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        await connectWithHandle(dirHandle);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          setStatus('Folder selection cancelled. Click "Connect Document Folder" whenever ready.', 'warn');
        } else {
          setStatus(`Could not connect folder: ${(err && err.message) || err}`, 'err');
        }
      }
    });
  }

  if (reauthBtn) {
    reauthBtn.addEventListener('click', async () => {
      if (!currentRecord || !currentRecord.dirHandle || !dbApi) return;
      const perm = await dbApi.checkHandlePermission(currentRecord.dirHandle, { requestIfPrompt: true });
      if (perm !== 'granted') {
        setStatus('Permission was not granted. You can reconnect or use Choose File on web forms.', 'warn');
      }
      await refreshView();
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      if (!dbApi) return;
      await dbApi.clearDirectoryHandle();
      currentRecord = null;
      await refreshView();
    });
  }

  window.SleepwalkerShelfPage = { refreshView, connectWithHandle };
  refreshView();
})();
