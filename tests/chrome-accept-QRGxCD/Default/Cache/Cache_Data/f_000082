/**
 * Sleepwalker - camera.js
 * Phase C4: Camera Capture & Honest Permission Helper
 *
 * Honest Browser Constraints:
 * - An extension CANNOT click Chrome's camera permission pop-up or unblock denied settings.
 * - Speech recognition results do not count as user activation if the browser requires a click.
 * - Camera capture is strictly local (Canvas -> JPEG File -> DataTransfer attach); never uploaded
 *   to Sleepwalker servers or sent to any LLM, and ALL MediaStreamTracks are stopped immediately
 *   after capture, retake, cancel, Escape, or panel close.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerCamera = api.SleepwalkerCamera;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  class SleepwalkerCamera {
    constructor(widget, options = {}) {
      this.widget = widget || null;
      this.onCardChange = typeof options.onCardChange === 'function' ? options.onCardChange : null;

      this.cardState = null; // null | { stage: 'permission_help'|'live'|'countdown'|'preview'|'error', target, stream, countdown, previewUrl, capturedFile, error, permState, helpSteps }
      this.activeStream = null;
      this._countdownTimer = null;
      this._timers = {
        countdownStepMs: typeof options.countdownStepMs === 'number' ? options.countdownStepMs : 1000
      };

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', () => this.stopAllTracks());
      }
    }

    setTimers(overrides = {}) {
      if (typeof overrides.countdownStepMs === 'number') {
        this._timers.countdownStepMs = Math.max(10, overrides.countdownStepMs);
      }
    }

    isActive() {
      return Boolean(this.cardState);
    }

    /**
     * Find image upload target (or disambiguate), inspect camera permission, and start preview or honest permission helper.
     */
    async requestCapture(query = '', explicitTarget = null) {
      const uploader = this.widget && this.widget.upload;
      if (!uploader) {
        return { ok: false, reason: 'upload_module_missing' };
      }

      let target = explicitTarget;
      if (!target) {
        const allTargets = uploader.detectUploadTargets();
        const imageCapable = allTargets.filter((t) => !t.accept || /image|\.(?:jpe?g|png|webp)/i.test(t.accept));
        const pool = imageCapable.length > 0 ? imageCapable : allTargets;
        if (pool.length === 0) {
          const msg = 'No file upload fields found on this page to attach a camera photo.';
          this._announce(msg, { openBubble: true, state: 'idle' });
          return { ok: false, reason: 'no_targets' };
        }

        const cleanQ = String(query || '')
          .toLowerCase()
          .replace(/\b(?:take|capture|click|shoot|open|use|my|a|an|the|camera|photo|picture|selfie|image|khincho|kholo|lo|le|kar|कर|खोलो|खींचो|फोटो|सेल्फी)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (cleanQ) {
          const ranked = uploader.findMatchingUploadTargets(cleanQ).filter((r) => pool.includes(r.target));
          if (ranked.length > 0) target = ranked[0].target;
        }

        if (!target) {
          if (pool.length === 1) {
            target = pool[0];
          } else {
            const ranked = uploader.findMatchingUploadTargets(cleanQ || 'photo').filter((r) => pool.includes(r.target));
            const topGap = ranked.length > 1 ? (ranked[0].score - ranked[1].score) : 100;
            const confirmMgr = this.widget && this.widget.confirm;
            if (ranked.length > 1 && topGap < 15 && confirmMgr) {
              const opts = ranked.slice(0, 5).map((r) => ({ label: r.target.label, target: r.target }));
              confirmMgr.request({
                id: `camera_pick_${Date.now()}`,
                risk: 'high',
                ambiguous: true,
                title: 'Choose Field for Camera Photo',
                message: `Multiple photo fields found: ${opts.map((o, i) => `${i + 1}. ${o.label}`).join(', ')}. Which number?`,
                options: opts,
                onConfirm: ({ selectedOption } = {}) => {
                  const chosen = (selectedOption && selectedOption.target) || ranked[0].target;
                  this.startCamera(chosen);
                },
                onCancel: () => {
                  this._announce('Camera capture cancelled.', { state: 'idle' });
                }
              });
              return { ok: true, awaitingDisambiguation: true };
            }
            target = (ranked[0] && ranked[0].target) || pool[0];
          }
        }
      }

      if (target.visualElement && typeof target.visualElement.scrollIntoView === 'function') {
        target.visualElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (typeof uploader._highlightTarget === 'function') {
        uploader._highlightTarget(target.visualElement || target.inputElement);
      }

      return await this.startCamera(target);
    }

    async inspectPermission() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return { supported: false, state: 'unsupported' };
      }
      try {
        if (navigator.permissions && typeof navigator.permissions.query === 'function') {
          const status = await navigator.permissions.query({ name: 'camera' });
          return { supported: true, state: status && status.state ? status.state : 'prompt' };
        }
      } catch (_e) {}
      return { supported: true, state: 'prompt' };
    }

    async startCamera(target) {
      this._clearCountdown();
      this.stopAllTracks();
      this._revokePreviewUrl();

      const permInfo = await this.inspectPermission();
      if (!permInfo.supported) {
        return this._showPermissionHelper(target, 'unsupported');
      }
      if (permInfo.state === 'denied') {
        return this._showPermissionHelper(target, 'denied');
      }
      if (permInfo.state === 'prompt') {
        this._announce('Chrome will ask for camera access. Click Allow near the address bar.', { openBubble: true });
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        this.activeStream = stream;
        this.cardState = {
          stage: 'live',
          target,
          stream,
          countdown: null,
          previewUrl: '',
          capturedFile: null,
          error: '',
          permState: 'granted',
          helpSteps: []
        };
        this._emitCardChange();
        this._registerDialogueActions(target);
        this._announce(`Camera preview active for "${target.label}". Say "Take photo" or tap Take Photo for a 3-2-1 countdown.`, { openBubble: true });
        return { ok: true, stage: 'live', target };
      } catch (err) {
        const errName = (err && err.name) || '';
        const mode = (errName === 'NotFoundError' || errName === 'DevicesNotFoundError')
          ? 'no_camera'
          : (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || errName === 'SecurityError' ? 'denied_or_gesture' : 'error');
        return this._showPermissionHelper(target, mode, err && err.message ? err.message : '');
      }
    }

    _showPermissionHelper(target, reason = 'prompt', detailMsg = '') {
      let helpSteps = [];
      let spoken = '';

      if (reason === 'unsupported') {
        helpSteps = [
          'This page or browser context does not expose navigator.mediaDevices.getUserMedia.',
          'Tap "Upload File Instead" below to choose an image file safely.'
        ];
        spoken = 'Camera is unavailable here because getUserMedia is not supported. Use Upload File Instead.';
      } else if (reason === 'no_camera') {
        helpSteps = [
          'No camera hardware was detected on this device.',
          'Check camera connection or tap "Upload File Instead" below.'
        ];
        spoken = 'No camera was found on your device. Please connect one or choose an image file.';
      } else if (reason === 'denied') {
        helpSteps = [
          'Chrome extensions cannot click Chrome\'s permission pop-up for you.',
          '1. Click the lock icon (or tune icon) in the address bar -> Site settings.',
          '2. Change Camera permission to "Allow".',
          '3. Say "ready" or tap "Retry Camera" below.'
        ];
        spoken = 'Camera permission is blocked. Click the lock icon or tune icon in the address bar, go to Site settings, set Camera to Allow, then say ready or tap Retry Camera.';
      } else {
        helpSteps = [
          'Chrome requires a direct click/tap or Allow click on the browser popup (extensions cannot click permission popups).',
          '1. Tap "Enable / Retry Camera" below.',
          '2. Click "Allow" when Chrome shows the camera prompt at the top-left.'
        ];
        spoken = 'Tap Enable Camera below, then click Allow in Chrome\'s popup to start the preview.';
      }

      this.cardState = {
        stage: 'permission_help',
        target,
        stream: null,
        countdown: null,
        previewUrl: '',
        capturedFile: null,
        error: detailMsg || '',
        permState: reason,
        helpSteps
      };
      this._emitCardChange();
      this._announce(spoken, { openBubble: true, state: 'idle' });
      return { ok: false, stage: 'permission_help', reason, helpSteps };
    }

    /**
     * Trigger visible 3-2-1 countdown and capture JPEG frame cleanly.
     */
    captureWithCountdown(seconds = 3) {
      if (!this.cardState || (this.cardState.stage !== 'live' && this.cardState.stage !== 'countdown')) {
        return Promise.resolve({ ok: false, reason: 'camera_not_live' });
      }
      this._clearCountdown();

      return new Promise((resolve) => {
        let remaining = Math.max(1, Number(seconds) || 3);
        const tick = async () => {
          if (!this.cardState) {
            resolve({ ok: false, cancelled: true });
            return;
          }
          if (remaining > 0) {
            this.cardState.stage = 'countdown';
            this.cardState.countdown = remaining;
            this._emitCardChange();
            const spokenWord = remaining === 3 ? 'Three' : (remaining === 2 ? 'Two' : (remaining === 1 ? 'One' : `${remaining}...`));
            this._announce(spokenWord, { openBubble: true });
            remaining -= 1;
            this._countdownTimer = setTimeout(tick, this._timers.countdownStepMs);
          } else {
            this._countdownTimer = null;
            const res = await this.captureNow();
            resolve(res);
          }
        };
        tick();
      });
    }

    /**
     * Capture frame from live <video> (or mock stream track frame), convert to JPEG File,
     * validate size limits (compressing if needed), stop all camera tracks, and show preview confirmation.
     */
    async captureNow(videoEl = null) {
      if (!this.cardState || !this.cardState.target) return { ok: false, reason: 'no_session' };
      this._clearCountdown();

      const target = this.cardState.target;
      const vid = videoEl || this._findRenderedVideo();
      const doc = typeof document !== 'undefined' ? document : null;
      if (!doc) {
        this.stopAllTracks();
        return { ok: false, reason: 'no_document' };
      }

      const canvas = doc.createElement('canvas');
      const w = (vid && vid.videoWidth) || 640;
      const h = (vid && vid.videoHeight) || 480;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) {
        if (vid && typeof vid.readyState === 'number' && vid.readyState >= 2) {
          ctx.drawImage(vid, 0, 0, w, h);
        } else {
          ctx.fillStyle = '#1E293B';
          ctx.fillRect(0, 0, w, h);
        }
      }

      let blob = await new Promise((resolve) => {
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9);
        } else {
          resolve(null);
        }
      });
      if (!blob && typeof Blob === 'function') {
        blob = new Blob(['jpeg-fallback'], { type: 'image/jpeg' });
      }

      // Stop camera stream hardware immediately once frame is captured!
      this.stopAllTracks();

      const FileCtor = typeof File === 'function'
        ? File
        : function MockFile(parts, n, opts) { this.name = n; this.type = (opts && opts.type) || 'image/jpeg'; this.size = (blob && blob.size) || 1024; this.lastModified = Date.now(); };
      let file = new FileCtor([blob], 'camera-capture.jpg', { type: 'image/jpeg', lastModified: Date.now() });

      const uploader = this.widget && this.widget.upload;
      let errMsg = '';
      if (uploader && target.maxBytes && file.size > target.maxBytes && typeof uploader.compressImageToTargetLimit === 'function') {
        try {
          const compressed = await uploader.compressImageToTargetLimit(file, target.maxBytes);
          if (compressed) file = compressed;
        } catch (_e) {}
      }
      if (uploader && typeof uploader.validateSelectedFile === 'function') {
        const val = uploader.validateSelectedFile(file, target);
        if (!val.valid) errMsg = val.reason;
      }

      let previewUrl = '';
      try {
        previewUrl = (typeof canvas.toDataURL === 'function' && canvas.toDataURL('image/jpeg', 0.85))
          || (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '');
      } catch (_e) {}

      this.cardState = {
        stage: 'preview',
        target,
        stream: null,
        countdown: null,
        previewUrl,
        capturedFile: file,
        error: errMsg,
        permState: 'granted',
        helpSteps: []
      };
      this._emitCardChange();

      const dlg = this.widget && this.widget.dialogue;
      const confirmMgr = this.widget && this.widget.confirm;
      if (!errMsg && confirmMgr) {
        if (dlg && dlg.pendingPrompt && dlg.pendingPrompt.label === 'camera_live') {
          dlg.setPendingPrompt(null);
        }
        confirmMgr.request({
          id: `camera_attach_${Date.now()}`,
          risk: 'high',
          title: 'Attach Camera Photo?',
          message: `Attach "${file.name}" (${Math.max(1, Math.round(file.size / 1024))} KB) to "${target.label}"?`,
          summary: [
            `Captured: ${file.name}`,
            `Field: ${target.label}`,
            'Privacy: Processed locally on your device; never sent to any AI.'
          ],
          onConfirm: () => this.confirmAttach(),
          onCancel: (reason) => {
            if (reason !== 'replaced' && reason !== 'retake') {
              this.cancelCapture();
            }
          }
        });
      } else if (!errMsg && dlg) {
        dlg.setPendingPrompt({
          kind: 'yesno',
          label: 'camera_attach',
          askedText: `Photo captured (${Math.max(1, Math.round(file.size / 1024))} KB). Attach to "${target.label}"? Say Yes, Retake, or Cancel.`,
          onAnswer: (yes) => {
            if (yes) return this.confirmAttach();
            return this.cancelCapture();
          }
        });
      }

      const msg = errMsg
        ? `${errMsg} Tap Retake or Upload File Instead.`
        : `Photo ready (${Math.max(1, Math.round(file.size / 1024))} KB). Say "Yes" to attach, "Retake", or "Cancel".`;
      this._announce(msg, { openBubble: true });
      return { ok: !errMsg, stage: 'preview', fileName: file.name, error: errMsg };
    }

    confirmAttach() {
      if (!this.cardState || !this.cardState.capturedFile || !this.cardState.target) {
        return { ok: false, reason: 'no_captured_photo' };
      }
      const { capturedFile, target } = this.cardState;
      const uploader = this.widget && this.widget.upload;
      if (!uploader) return { ok: false };
      const res = uploader.attachFileToTarget(capturedFile, target);
      if (res && res.ok) {
        if (this.widget) this.widget.lastUndoableType = 'upload';
        this.cardState = null;
        this._revokePreviewUrl();
        this._emitCardChange();
      }
      return res;
    }

    async retake() {
      if (!this.cardState || !this.cardState.target) return { ok: false };
      const target = this.cardState.target;
      if (this.widget && this.widget.confirm && this.widget.confirm.isAwaiting()) {
        this.widget.confirm.cancel('retake');
      }
      return await this.startCamera(target);
    }

    cancelCapture() {
      this._clearCountdown();
      this.stopAllTracks();
      this._revokePreviewUrl();
      if (this.widget && this.widget.confirm && this.widget.confirm.isAwaiting()) {
        this.widget.confirm.cancel('replaced');
      }
      const dlg = this.widget && this.widget.dialogue;
      if (dlg && dlg.pendingPrompt && (dlg.pendingPrompt.label === 'camera_live' || dlg.pendingPrompt.label === 'camera_attach')) {
        dlg.setPendingPrompt(null);
      }
      const wasActive = Boolean(this.cardState);
      this.cardState = null;
      this._emitCardChange();
      if (wasActive) {
        this._announce('Camera capture cancelled.', { state: 'idle' });
      }
      return true;
    }

    /**
     * Stop ALL media stream tracks cleanly to turn off camera hardware immediately.
     */
    stopAllTracks() {
      if (this.activeStream && typeof this.activeStream.getTracks === 'function') {
        for (const track of this.activeStream.getTracks()) {
          try { track.stop(); } catch (_e) {}
        }
      }
      this.activeStream = null;
    }

    /**
     * Handle live camera voice commands ("capture", "shoot", "retake", "cancel").
     */
    handleVoiceCommand(rawText) {
      if (!this.cardState) return false;
      const lower = String(rawText || '').trim().toLowerCase();
      if (this.cardState.stage === 'permission_help' && /^(?:ready|done|retry|try\s+again|ho\s+gaya|हो\s+गया)$/i.test(lower)) {
        this.startCamera(this.cardState.target);
        return true;
      }
      if (this.cardState.stage === 'live' && /^(?:take\s+(?:it|photo|now)|capture|shoot|click|cheese|ready|khincho|फोटो\s+खींचो)$/i.test(lower)) {
        this.captureWithCountdown(3);
        return true;
      }
      if (/^(?:retake|retry|again|dobara|phir\s+se|फिर\s+से)$/i.test(lower)) {
        this.retake();
        return true;
      }
      if (/^(?:cancel|close|stop|band\s+karo|nahi|नहीं)$/i.test(lower)) {
        this.cancelCapture();
        return true;
      }
      return false;
    }

    _registerDialogueActions(target) {
      const dlg = this.widget && this.widget.dialogue;
      if (!dlg) return;
      dlg.setPendingPrompt({
        kind: 'question',
        label: 'camera_live',
        askedText: `Camera preview open for ${target.label}. Say "Take photo", "Retake", or "Cancel".`,
        onAnswer: (raw) => {
          if (this.handleVoiceCommand(raw)) return { ok: true };
          return { handled: false };
        }
      });
    }

    _findRenderedVideo() {
      const sr = this.widget && this.widget.shadowRoot;
      if (!sr) return null;
      return sr.querySelector('#sw-pill-camera-card video') || sr.querySelector('#sw-panel-camera-card video') || null;
    }

    _clearCountdown() {
      if (this._countdownTimer) {
        clearTimeout(this._countdownTimer);
        this._countdownTimer = null;
      }
    }

    _revokePreviewUrl() {
      if (this.cardState && this.cardState.previewUrl && this.cardState.previewUrl.startsWith('blob:') && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        try { URL.revokeObjectURL(this.cardState.previewUrl); } catch (_e) {}
      }
    }

    _emitCardChange() {
      if (this.onCardChange) this.onCardChange(this.cardState);
      if (this.widget && typeof this.widget.handleCameraCardChange === 'function') {
        this.widget.handleCameraCardChange(this.cardState);
      }
    }

    _announce(msg, { openBubble = false, state = 'status' } = {}) {
      if (!this.widget) return;
      if (typeof this.widget.setAssistantReply === 'function') this.widget.setAssistantReply(msg);
      if (typeof window !== 'undefined' && window.SW_UI) {
        if (!this.cardState && (!this.widget.confirm || !this.widget.confirm.isAwaiting())) {
          window.SW_UI.showCard({
            type: state === 'error' ? 'error' : 'answer',
            title: 'Camera',
            text: msg,
            reading: true
          });
        }
      } else if (this.widget.pill) {
        if (state === 'idle' && typeof this.widget.pill.setIdle === 'function') this.widget.pill.setIdle(msg);
        else if (typeof this.widget.pill.setStatus === 'function') this.widget.pill.setStatus(msg);
        if (openBubble && typeof this.widget.pill.openBubble === 'function') this.widget.pill.openBubble();
      }
      if (this.widget.reader && typeof this.widget.reader.readText === 'function') {
        this.widget.reader.readText(msg);
      }
    }
  }

  return { SleepwalkerCamera };
});
