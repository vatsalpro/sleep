/**
 * Sleepwalker - shelf-db.js
 * Phase C3: Shared IndexedDB FileSystemDirectoryHandle store + filename fuzzy matcher.
 * Runs cleanly inside Extension Service Worker (background.js), Shelf Setup Page (shelf.html),
 * Content Scripts (upload.js), and Node tests.
 * Privacy: Stores ONLY browser FileSystemDirectoryHandle inside extension-origin IndexedDB;
 * never stores paths/contents in chrome.storage.local and never sends filenames to any LLM.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerShelfDB = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DB_NAME = 'sleepwalker_shelf_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'shelf_handles';
  const PRIMARY_KEY = 'primary_dir';
  const MAX_READ_BYTES = 25 * 1024 * 1024; // 25 MB safety cap for IPC transfer

  function openShelfDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open shelf IndexedDB'));
    });
  }

  async function saveDirectoryHandle(dirHandle, meta = {}) {
    const db = await openShelfDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const record = {
          dirHandle,
          folderName: (dirHandle && dirHandle.name) || meta.folderName || 'Document Shelf',
          updatedAt: Date.now()
        };
        const req = store.put(record, PRIMARY_KEY);
        req.onsuccess = () => resolve({ ok: true, folderName: record.folderName });
        req.onerror = () => reject(req.error || new Error('Failed to save shelf handle'));
      });
    } finally {
      db.close();
    }
  }

  async function loadDirectoryRecord() {
    if (typeof indexedDB === 'undefined') return null;
    const db = await openShelfDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(PRIMARY_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('Failed to read shelf handle'));
      });
    } finally {
      db.close();
    }
  }

  async function clearDirectoryHandle() {
    if (typeof indexedDB === 'undefined') return { ok: true };
    const db = await openShelfDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(PRIMARY_KEY);
        req.onsuccess = () => resolve({ ok: true });
        req.onerror = () => reject(req.error || new Error('Failed to clear shelf handle'));
      });
    } finally {
      db.close();
    }
  }

  async function checkHandlePermission(dirHandle, { requestIfPrompt = false } = {}) {
    if (!dirHandle) return 'missing';
    try {
      if (typeof dirHandle.queryPermission === 'function') {
        const perm = await dirHandle.queryPermission({ mode: 'read' });
        if (perm === 'granted') return 'granted';
        if (requestIfPrompt && perm === 'prompt' && typeof dirHandle.requestPermission === 'function') {
          return await dirHandle.requestPermission({ mode: 'read' });
        }
        return perm;
      }
      return 'granted';
    } catch (_e) {
      return 'denied';
    }
  }

  /**
   * Collect up to maxFiles file entries from dirHandle (root + 1 subfolder level).
   */
  async function collectHandleFiles(dirHandle, maxFiles = 200) {
    const entries = [];
    if (!dirHandle || typeof dirHandle.values !== 'function') return entries;

    for await (const entry of dirHandle.values()) {
      if (!entry) continue;
      if (entry.kind === 'file') {
        entries.push({
          name: entry.name,
          path: entry.name,
          fileHandle: entry
        });
        if (entries.length >= maxFiles) break;
      } else if (entry.kind === 'directory' && typeof entry.values === 'function') {
        try {
          for await (const sub of entry.values()) {
            if (sub && sub.kind === 'file') {
              entries.push({
                name: sub.name,
                path: `${entry.name}/${sub.name}`,
                fileHandle: sub
              });
              if (entries.length >= maxFiles) break;
            }
          }
        } catch (_e) {}
        if (entries.length >= maxFiles) break;
      }
    }
    return entries;
  }

  const SYNONYM_TAGS = {
    photo: ['photo', 'passport', 'pic', 'picture', 'portrait', 'selfie', 'avatar', 'headshot', 'img', 'image'],
    marksheet: ['marksheet', 'marks', 'grade', 'scorecard', 'transcript', 'result', 'tenth', '10th', 'twelfth', '12th', 'degree'],
    income: ['income', 'aay', 'salary', 'itr', 'earning'],
    certificate: ['certificate', 'cert', 'pramanpatra', 'proof'],
    resume: ['resume', 'cv', 'bio', 'biodata', 'curriculum'],
    id: ['id', 'identity', 'card', 'voter', 'driving', 'license', 'licence'],
    signature: ['signature', 'sign', 'hastakshar']
  };

  function expandQueryTokens(query) {
    const raw = String(query || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !['my', 'the', 'for', 'and', 'upload', 'attach', 'file', 'document', 'doc', 'karo'].includes(t));

    const expanded = new Set(raw);
    for (const tok of raw) {
      for (const group of Object.values(SYNONYM_TAGS)) {
        if (group.includes(tok)) {
          group.forEach((syn) => expanded.add(syn));
        }
      }
    }
    return { raw, expanded: Array.from(expanded) };
  }

  function rankShelfEntries(entries, query = '', acceptStr = '', matchAcceptFn = null) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const { raw, expanded } = expandQueryTokens(query);

    const scored = [];
    for (const item of entries) {
      const name = String(item && item.name ? item.name : '');
      const pathStr = String((item && item.path) || name);
      if (!name) continue;
      if (typeof matchAcceptFn === 'function' && acceptStr && !matchAcceptFn({ name, type: '' }, acceptStr)) {
        continue;
      }

      const lowerName = name.toLowerCase().replace(/[_.-]+/g, ' ');
      const lowerPath = pathStr.toLowerCase().replace(/[_./-]+/g, ' ');
      let score = 0;

      for (const tok of raw) {
        if (lowerName.includes(tok)) score += 3;
        else if (lowerPath.includes(tok)) score += 2;
      }
      for (const syn of expanded) {
        if (!raw.includes(syn) && (lowerName.includes(syn) || lowerPath.includes(syn))) {
          score += 1.2;
        }
      }

      if (score > 0 || raw.length === 0) {
        scored.push({ ...item, score: Math.round((score || 0.5) * 10) / 10 });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored;
  }

  async function readEntryTransferPayload(entry) {
    if (!entry || !entry.fileHandle || typeof entry.fileHandle.getFile !== 'function') {
      return { ok: false, error: 'Missing file handle.' };
    }
    const file = await entry.fileHandle.getFile();
    if (file.size > MAX_READ_BYTES) {
      return {
        ok: false,
        tooLarge: true,
        name: file.name,
        size: file.size,
        error: `"${file.name}" is larger than ${Math.round(MAX_READ_BYTES / (1024 * 1024))} MB transfer cap. Use Choose File instead.`
      };
    }
    const buf = await file.arrayBuffer();
    return {
      ok: true,
      name: file.name,
      path: entry.path || file.name,
      type: file.type || '',
      size: file.size,
      lastModified: file.lastModified || Date.now(),
      bytes: Array.from(new Uint8Array(buf))
    };
  }

  return {
    DB_NAME,
    MAX_READ_BYTES,
    openShelfDb,
    saveDirectoryHandle,
    loadDirectoryRecord,
    clearDirectoryHandle,
    checkHandlePermission,
    collectHandleFiles,
    rankShelfEntries,
    readEntryTransferPayload
  };
});
