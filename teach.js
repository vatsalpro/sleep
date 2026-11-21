/**
 * Sleepwalker 2.0 — teach.js
 * Demonstration-based workflow learning, persistent semantic step capture across reloads,
 * live DOM/World-Model revalidation (never blind coordinate replay), confirmation-gated skill saving,
 * and failed-step relearning (creating versioned updates while keeping previous versions).
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerTeach) return;

  const SENSITIVE_FIELD_RE = /\b(?:password|passwd|pwd|otp|pin\b(?!code)|cvv|cvc|card|aadhaar|aadhar|pan|ifsc|secret|token|auth)\b/i;

  function cleanText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function norm(s) {
    return cleanText(s).toLowerCase();
  }

  function getAttr(el, name) {
    try { return el && typeof el.getAttribute === 'function' ? (el.getAttribute(name) || '') : ''; } catch (_e) { return ''; }
  }

  function isVisibleElement(el, doc) {
    if (!el || el.nodeType !== 1 || el.isConnected === false) return false;
    if (getAttr(el, 'aria-hidden') === 'true' || el.hidden) return false;
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      } catch (_e) {}
    }
    return true;
  }

  function isInsideSleepwalker(el) {
    if (!el || typeof el.closest !== 'function') return false;
    return Boolean(el.closest('#sleepwalker-ui-host, #sleepwalker-host, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"]'));
  }

  class SleepwalkerTeach {
    constructor(controller = null) {
      this.controller = controller || null;
      this.active = false;
      this.paused = false;
      this.session = null;
      this._listenersAttached = false;
      this._lastEventSig = '';
      this._lastEventAt = 0;

      this._onClickBound = (e) => this._handleDomEvent('click', e);
      this._onChangeBound = (e) => this._handleDomEvent('change', e);
    }

    isTeachingActive() {
      return Boolean(this.active);
    }

    _getDoc() {
      return typeof document !== 'undefined' ? document : null;
    }

    _getMemory() {
      return this.controller && this.controller.memory ? this.controller.memory : null;
    }

    _getSiteHost(doc = this._getDoc()) {
      try {
        const href = (doc && doc.location && doc.location.href) || (typeof window !== 'undefined' && window.location && window.location.href) || '';
        return href ? new URL(href).hostname.toLowerCase() : 'local';
      } catch (_e) {
        return 'local';
      }
    }

    _getCleanUrl(doc = this._getDoc()) {
      const mem = this._getMemory();
      const raw = (doc && doc.location && doc.location.href) || (typeof window !== 'undefined' && window.location && window.location.href) || '';
      if (mem && typeof mem._sanitizeStoredUrl === 'function') return mem._sanitizeStoredUrl(raw);
      return String(raw).split(/[?#]/)[0];
    }

    _findEnclosingSectionLabel(el) {
      if (!el || typeof el.closest !== 'function') return '';
      const sec = el.closest('section, article, fieldset, nav, aside, [role="region"], [role="navigation"], [role="menu"], [role="tablist"], form');
      if (sec && typeof sec.querySelector === 'function') {
        const h = sec.querySelector('h1, h2, h3, h4, legend, [role="heading"]');
        if (h) return cleanText(h.innerText || h.textContent).slice(0, 80);
        const lbl = getAttr(sec, 'aria-label');
        if (lbl) return cleanText(lbl).slice(0, 80);
      }
      return '';
    }

    extractSemanticSignature(el, doc = this._getDoc()) {
      if (!el || el.nodeType !== 1) return null;
      const tag = String(el.tagName || '').toLowerCase();
      const inputType = String(getAttr(el, 'type') || el.type || '').toLowerCase();
      const role = String(getAttr(el, 'role') || '').toLowerCase() || (tag === 'a' ? 'link' : (tag === 'button' ? 'button' : tag));
      const ariaLabel = cleanText(getAttr(el, 'aria-label'));
      const placeholder = cleanText(getAttr(el, 'placeholder'));
      const idAttr = cleanText(el.id || '');
      const nameAttr = cleanText(getAttr(el, 'name'));
      let label = ariaLabel || '';
      if (!label && idAttr && doc && typeof doc.querySelector === 'function') {
        try {
          const lblEl = doc.querySelector(`label[for="${CSS.escape ? CSS.escape(idAttr) : idAttr}"]`);
          if (lblEl) label = cleanText(lblEl.innerText || lblEl.textContent);
        } catch (_e) {}
      }
      if (!label && typeof el.closest === 'function') {
        const wrapLbl = el.closest('label');
        if (wrapLbl) label = cleanText(wrapLbl.innerText || wrapLbl.textContent);
      }
      if (!label) {
        label = cleanText(el.innerText || el.textContent || getAttr(el, 'title') || getAttr(el, 'value') || placeholder || nameAttr || idAttr);
      }
      const sensitive = inputType === 'password' || SENSITIVE_FIELD_RE.test(`${label} ${nameAttr} ${idAttr} ${placeholder}`);
      const hrefRaw = tag === 'a' ? getAttr(el, 'href') : '';
      let hrefPath = '';
      if (hrefRaw) {
        try {
          const u = new URL(hrefRaw, (doc && doc.location && doc.location.href) || 'http://localhost');
          hrefPath = u.pathname;
        } catch (_e) {
          hrefPath = String(hrefRaw).split(/[?#]/)[0];
        }
      }
      let rectHint = null;
      try {
        const r = el.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) {
          rectHint = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      } catch (_e) {}

      return {
        tag,
        role,
        elementType: inputType || role,
        label: label.slice(0, 110),
        accessibleName: (ariaLabel || label).slice(0, 110),
        ariaLabel: ariaLabel.slice(0, 100),
        placeholder: placeholder.slice(0, 80),
        idAttr: idAttr.slice(0, 80),
        nameAttr: nameAttr.slice(0, 80),
        parentSection: this._findEnclosingSectionLabel(el),
        hrefPath,
        sensitive,
        fallbackRect: rectHint
      };
    }

    /**
     * 6.1 Prompt user to demonstrate how to complete an unresolvable action (never triggered for trivial delays).
     */
    promptTeachOffer({ command = '', reason = '', taskId = 0, onRetry = null } = {}) {
      const ctrl = this.controller;
      const msg = `I couldn't complete "${cleanText(command).slice(0, 90) || 'this action'}". Would you like to show me how?`;
      if (ctrl && typeof ctrl.setAssistantReply === 'function') ctrl.setAssistantReply(msg);
      if (ctrl && ctrl.reader) ctrl.reader.readText(msg);

      const enterTeach = () => this.startTeaching(command, { mode: 'teach', previousError: reason });
      const retryAct = () => {
        if (typeof onRetry === 'function') return onRetry();
        if (ctrl && typeof ctrl.handleUserInput === 'function') return ctrl.handleUserInput(command, 'typed');
        return null;
      };
      const cancelAct = () => {
        if (ctrl && typeof ctrl.cancelActiveTask === 'function') ctrl.cancelActiveTask('Cancelled.');
      };

      if (typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.setState('confirm');
        window.SW_UI.showCard({
          type: 'choices',
          title: 'Action Could Not Complete',
          text: `${msg}${reason ? `\n(${cleanText(reason).slice(0, 110)})` : ''}`,
          choices: ['Teach Sleepwalker', 'Try again', 'Cancel'],
          actions: [
            { id: 'teach', label: 'Teach Sleepwalker', primary: true },
            { id: 'retry', label: 'Try again' },
            { id: 'cancel', label: 'Cancel' }
          ],
          onAction: async (actId, data) => {
            const idx = data && typeof data.index === 'number' ? data.index : -1;
            if (actId === 'teach' || (actId === 'choose' && idx === 0)) return enterTeach();
            if (actId === 'retry' || (actId === 'choose' && idx === 1)) return retryAct();
            return cancelAct();
          }
        });
      }

      if (ctrl && typeof ctrl._enterWaitingForClarification === 'function') {
        ctrl._enterWaitingForClarification(taskId, msg, async (answerText, info) => {
          const low = norm(answerText);
          if (/^(?:please\s+)?(?:teach|show(?:\s+me)?|demonstrate|record|yes|ok|okay|sure|1)\.?$/i.test(low) ||
              /\b(?:teach\s+sleepwalker|show\s+you|record\s+(?:this|workflow|skill))\b/i.test(low)) {
            return await enterTeach();
          }
          if (/^(?:please\s+)?(?:try\s*again|retry|repeat|2)\.?$/i.test(low)) {
            return await retryAct();
          }
          if (/^(?:cancel|no|nope|nah|dismiss|close|stop|never\s*mind|no\s*need|leave\s*it|forget\s*it|3)\.?$/i.test(low)) {
            cancelAct();
            return { status: 'task_cancelled', answer: 'Cancelled.' };
          }
          if (typeof window !== 'undefined' && window.SW_UI && typeof window.SW_UI.hideCard === 'function') {
            window.SW_UI.hideCard();
          }
          if (ctrl && typeof ctrl._processUserInputInner === 'function') {
            return ctrl._processUserInputInner(answerText, (info && info.inputSource) || 'voice', {
              ...((info && info.meta) || {}),
              internalResumeTaskId: (info && info.taskId) || taskId
            });
          }
          cancelAct();
          return { status: 'task_cancelled', answer: 'Cancelled.' };
        });
      }
      return { status: 'needs_clarification', offerTeach: true, message: msg };
    }

    async startTeaching(instruction, opts = {}) {
      const mem = this._getMemory();
      const doc = this._getDoc();
      const cleanInst = cleanText(instruction || 'Completed workflow');
      this.session = {
        id: `teach_${Date.now().toString(36)}`,
        instruction: cleanInst,
        website: this._getSiteHost(doc),
        startUrlClean: this._getCleanUrl(doc),
        mode: opts.mode === 'relearn' ? 'relearn' : 'teach',
        baseSkillId: opts.baseSkillId || null,
        startedAt: Date.now(),
        paused: false,
        steps: []
      };
      this.active = true;
      this.paused = false;
      this._attachListeners(doc);

      if (mem && mem.state) {
        mem.state.activeTeaching = this.session;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
      }
      this._renderTeachingUi();
      const msg = `Teaching mode started for "${cleanInst}". Perform the steps on this page, then say or click Finish Teaching.`;
      if (this.controller && this.controller.reader) this.controller.reader.readText(msg);
      return { status: 'teaching_started', sessionId: this.session.id, message: msg };
    }

    async pauseTeaching() {
      if (!this.active || !this.session) return { status: 'not_teaching' };
      this.paused = true;
      this.session.paused = true;
      const mem = this._getMemory();
      if (mem && mem.state) {
        mem.state.activeTeaching = this.session;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
      }
      this._renderTeachingUi();
      return { status: 'teaching_paused', steps: this.session.steps.length };
    }

    async resumeTeaching() {
      if (!this.active || !this.session) return { status: 'not_teaching' };
      this.paused = false;
      this.session.paused = false;
      this._attachListeners(this._getDoc());
      const mem = this._getMemory();
      if (mem && mem.state) {
        mem.state.activeTeaching = this.session;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
      }
      this._renderTeachingUi();
      return { status: 'teaching_resumed', steps: this.session.steps.length };
    }

    async cancelTeaching() {
      this._detachListeners(this._getDoc());
      this.active = false;
      this.paused = false;
      this.session = null;
      const mem = this._getMemory();
      if (mem && mem.state && mem.state.activeTeaching) {
        mem.state.activeTeaching = null;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
      }
      if (typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.setTaskStatus({ state: 'cancelled', stage: 'Teaching cancelled', taskLabel: '' });
        window.SW_UI.setState('silent');
        window.SW_UI.hideCard();
      }
      return { status: 'teaching_cancelled', answer: 'Teaching cancelled.' };
    }

    async finishTeaching() {
      if (!this.active || !this.session) return { status: 'not_teaching' };
      const finishedSession = { ...this.session, steps: (this.session.steps || []).slice() };
      this._detachListeners(this._getDoc());
      this.active = false;
      this.paused = false;
      const doc = this._getDoc();
      const endUrlClean = this._getCleanUrl(doc);
      if (finishedSession.steps.length > 0) {
        finishedSession.steps[finishedSession.steps.length - 1].resultingUrlClean = endUrlClean;
      }

      const mem = this._getMemory();
      if (mem && mem.state) {
        mem.state.activeTeaching = null;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
      }

      if (finishedSession.steps.length === 0) {
        const emptyMsg = 'No page interactions were recorded during teaching. Would you like to try again or cancel?';
        if (typeof window !== 'undefined' && window.SW_UI) {
          window.SW_UI.setState('idle');
          window.SW_UI.showCard({ type: 'error', title: 'No Steps Recorded', text: emptyMsg });
        }
        return { status: 'empty_demonstration', message: emptyMsg };
      }

      const summarySteps = finishedSession.steps.map((s, idx) => `${idx + 1}. ${s.action} "${s.label || s.role}"${s.parentSection ? ` in ${s.parentSection}` : ''}`);
      const confirmMsg = `Recorded ${finishedSession.steps.length} step(s) for "${finishedSession.instruction}". Did this complete your task? Confirm to save it as a reusable skill.`;

      const doSaveSkill = async () => {
        if (!mem || typeof mem.saveLearnedSkill !== 'function') {
          return { status: 'error', message: 'Memory module unavailable.' };
        }
        const saved = await mem.saveLearnedSkill({
          id: finishedSession.baseSkillId || undefined,
          name: finishedSession.instruction,
          instruction: finishedSession.instruction,
          website: finishedSession.website,
          pageContext: doc ? doc.title : '',
          steps: finishedSession.steps,
          verification: {
            expectedUrlIncludes: endUrlClean !== finishedSession.startUrlClean ? endUrlClean : '',
            expectedTitleIncludes: doc && doc.title ? cleanText(doc.title).slice(0, 60) : ''
          },
          confirmedByUser: true
        });
        this.session = null;
        const okMsg = saved
          ? `Saved skill "${saved.name}" (v${saved.version}) with ${saved.steps.length} step(s).`
          : 'Could not save learned skill.';
        if (this.controller && typeof this.controller.setAssistantReply === 'function') this.controller.setAssistantReply(okMsg);
        if (typeof window !== 'undefined' && window.SW_UI) {
          window.SW_UI.setState('speaking');
          window.SW_UI.setTaskStatus({ state: 'completed', stage: 'Skill saved', taskLabel: saved ? saved.name : '' });
          window.SW_UI.showCard({ type: 'answer', title: 'Skill Saved', text: okMsg, summaryLines: summarySteps });
        }
        if (this.controller && this.controller.reader) this.controller.reader.readText(okMsg);
        return { status: 'skill_saved', skill: saved, answer: okMsg };
      };

      const doDiscard = async () => {
        this.session = null;
        if (typeof window !== 'undefined' && window.SW_UI) {
          window.SW_UI.setTaskStatus({ state: 'cancelled', stage: 'Skill discarded', taskLabel: '' });
          window.SW_UI.setState('silent');
          window.SW_UI.showCard({ type: 'answer', title: 'Not Saved', text: 'Recorded steps were discarded.' });
        }
        return { status: 'skill_discarded', answer: 'Recorded steps discarded.' };
      };

      if (typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.setState('confirm');
        window.SW_UI.setTaskStatus({ state: 'waiting_for_clarification', stage: 'Confirm workflow', taskLabel: finishedSession.instruction });
        window.SW_UI.showCard({
          type: 'confirm',
          title: 'Save Learned Workflow?',
          text: confirmMsg,
          summaryLines: summarySteps,
          actions: [
            { id: 'save_skill', label: 'Confirm & Save', primary: true },
            { id: 'discard_skill', label: 'Cancel' }
          ],
          onAction: async (actId) => (actId === 'save_skill' || actId === 'yes' ? await doSaveSkill() : await doDiscard())
        });
      }

      if (this.controller && typeof this.controller._enterWaitingForClarification === 'function') {
        const tId = (this.controller.taskLifecycle && this.controller.taskLifecycle.activeTaskId) || Date.now();
        this.controller._enterWaitingForClarification(tId, confirmMsg, async (replyText) => {
          const low = norm(replyText);
          if (/\b(?:yes|confirm|save|correct|done|completed|yeah|yep|ok)\b/i.test(low)) {
            return await doSaveSkill();
          }
          return await doDiscard();
        });
      }
      if (this.controller && this.controller.reader) this.controller.reader.readText(confirmMsg);

      return { status: 'awaiting_skill_confirmation', steps: finishedSession.steps, doSaveSkill, doDiscard };
    }

    async restoreFromBoot() {
      const mem = this._getMemory();
      if (!mem || !mem.state) return null;
      const doc = this._getDoc();
      const curHost = this._getSiteHost(doc);
      const curUrl = this._getCleanUrl(doc);

      // 1. Continue in-progress teaching session across page reload/navigation
      const savedTeach = mem.state.activeTeaching;
      if (savedTeach && Array.isArray(savedTeach.steps) && savedTeach.website === curHost) {
        this.session = savedTeach;
        this.active = true;
        this.paused = Boolean(savedTeach.paused);
        if (this.session.steps.length > 0) {
          this.session.steps[this.session.steps.length - 1].resultingUrlClean = curUrl;
        }
        if (!this.paused) this._attachListeners(doc);
        this._renderTeachingUi();
        return { status: 'teaching_restored', steps: this.session.steps.length };
      }

      // 2. Continue multi-page skill replay cleanly on the destination page
      const pending = mem.state.pendingSkillReplay;
      if (pending && pending.skillId && Array.isArray(mem.state.learnedSkills) && (Date.now() - (pending.startedAt || 0)) < 45000) {
        const sk = mem.state.learnedSkills.find((s) => s && s.id === pending.skillId);
        mem.state.pendingSkillReplay = null;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
        if (sk) {
          return await this.executeLearnedSkill(sk, { utterance: pending.utterance || sk.instruction, fromStepIndex: pending.nextStepIndex || 0 });
        }
      }
      return null;
    }

    _attachListeners(doc = this._getDoc()) {
      if (!doc || this._listenersAttached || typeof doc.addEventListener !== 'function') return;
      doc.addEventListener('click', this._onClickBound, true);
      doc.addEventListener('change', this._onChangeBound, true);
      this._listenersAttached = true;
    }

    _detachListeners(doc = this._getDoc()) {
      if (!doc || !this._listenersAttached || typeof doc.removeEventListener !== 'function') return;
      try { doc.removeEventListener('click', this._onClickBound, true); } catch (_e) {}
      try { doc.removeEventListener('change', this._onChangeBound, true); } catch (_e) {}
      this._listenersAttached = false;
    }

    _handleDomEvent(evType, e) {
      if (!this.active || this.paused || !this.session || !e || !e.target) return;
      const target = e.target.nodeType === 1 ? e.target : e.target.parentElement;
      if (!target || isInsideSleepwalker(target)) return;

      const interactive = (target.closest && target.closest('a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"], label')) || target;
      if (isInsideSleepwalker(interactive)) return;

      const tag = String(interactive.tagName || '').toLowerCase();
      // For native select/input/checkbox/radio controls, capture 'change' rather than bare focus click unless link/button
      if (evType === 'click' && (tag === 'select' || (tag === 'input' && !['button', 'submit', 'reset'].includes(String(interactive.type || '').toLowerCase())))) {
        return;
      }

      const sig = this.extractSemanticSignature(interactive, this._getDoc());
      if (!sig || sig.sensitive || (!sig.label && !sig.idAttr && !sig.nameAttr && !sig.hrefPath)) return;

      let action = evType === 'change' ? 'select' : 'click';
      let value = '';
      let expectedState = '';
      if (tag === 'select') {
        action = 'select';
        const selOpt = interactive.options && interactive.selectedIndex >= 0 ? interactive.options[interactive.selectedIndex] : null;
        value = sig.sensitive ? '' : cleanText((selOpt && (selOpt.text || selOpt.label)) || interactive.value || '');
        expectedState = value ? `selected:${value}` : '';
      } else if (tag === 'input') {
        const itype = String(interactive.type || '').toLowerCase();
        if (itype === 'checkbox' || itype === 'radio') {
          action = itype === 'checkbox' ? (interactive.checked ? 'check' : 'uncheck') : 'select_radio';
          expectedState = interactive.checked ? 'checked' : 'unchecked';
        } else {
          action = 'fill';
          value = sig.sensitive ? '' : cleanText(interactive.value || '').slice(0, 100);
        }
      } else if (tag === 'textarea') {
        action = 'fill';
        value = sig.sensitive ? '' : cleanText(interactive.value || '').slice(0, 100);
      }

      const evSig = `${action}::${sig.tag}::${sig.idAttr}::${sig.label}::${value}`;
      const now = Date.now();
      if (evSig === this._lastEventSig && (now - this._lastEventAt) < 350) return;
      this._lastEventSig = evSig;
      this._lastEventAt = now;

      const doc = this._getDoc();
      this.session.steps.push({
        sequence: this.session.steps.length + 1,
        action,
        ...sig,
        value,
        pageUrlClean: this._getCleanUrl(doc),
        expectedState
      });

      const mem = this._getMemory();
      if (mem && mem.state) {
        mem.state.activeTeaching = this.session;
        mem.saveState({ skipTabSync: true }).catch(() => {});
      }
      this._renderTeachingUi();
    }

    _renderTeachingUi() {
      if (typeof window === 'undefined' || !window.SW_UI || !this.session) return;
      const cnt = (this.session.steps || []).length;
      const stText = this.paused ? `Paused (${cnt} step${cnt === 1 ? '' : 's'})` : `Recording (${cnt} step${cnt === 1 ? '' : 's'})`;
      const last = cnt > 0 ? this.session.steps[cnt - 1] : null;
      const body = `Goal: "${this.session.instruction}"\nStatus: ${stText}${last ? `\nLast step: ${last.action} "${last.label || last.role}"` : '\nInteract with the page controls now, then click Finish Teaching.'}`;
      window.SW_UI.setState('confirm');
      window.SW_UI.setTaskStatus({
        state: this.paused ? 'waiting_for_clarification' : 'processing',
        stage: this.paused ? 'Teaching paused' : 'Teaching mode',
        taskLabel: this.session.instruction,
        showCancel: true
      });
      window.SW_UI.showCard({
        type: 'answer',
        title: `Teach Sleepwalker — ${stText}`,
        text: body,
        actions: [
          this.paused ? { id: 'resume_teach', label: 'Resume' } : { id: 'pause_teach', label: 'Pause' },
          { id: 'finish_teach', label: 'Finish Teaching', primary: true },
          { id: 'cancel_teach', label: 'Cancel' }
        ],
        onAction: async (actId) => {
          if (actId === 'pause_teach') return await this.pauseTeaching();
          if (actId === 'resume_teach') return await this.resumeTeaching();
          if (actId === 'finish_teach') return await this.finishTeaching();
          if (actId === 'cancel_teach') return await this.cancelTeaching();
        }
      });
    }

    /**
     * Phase 6.5/6.8: Revalidate each step by semantic element identity on the live DOM
     * (role, accessibleName, label, parentSection, id/name/hrefPath) — NEVER blind coordinate clicks!
     */
    reidentifyStepElement(step, doc = this._getDoc()) {
      if (!step || !doc || typeof doc.querySelectorAll !== 'function') return null;
      const nodes = Array.from(doc.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"]'
      ));

      const stepLbl = norm(step.label || step.accessibleName || '');
      const stepAcc = norm(step.accessibleName || step.ariaLabel || '');
      const stepSec = norm(step.parentSection || '');
      const stepId = norm(step.idAttr || '');
      const stepName = norm(step.nameAttr || '');
      const stepHref = norm(step.hrefPath || '');
      const stepRole = norm(step.role || step.tag || '');

      let best = null;
      let bestScore = 0;

      for (const el of nodes) {
        if (isInsideSleepwalker(el) || !isVisibleElement(el, doc)) continue;
        const sig = this.extractSemanticSignature(el, doc);
        if (!sig) continue;

        let score = 0;
        const candLbl = norm(sig.label);
        const candAcc = norm(sig.accessibleName);
        const candSec = norm(sig.parentSection);
        const candId = norm(sig.idAttr);
        const candName = norm(sig.nameAttr);
        const candHref = norm(sig.hrefPath);
        const candRole = norm(sig.role || sig.tag);

        if (stepLbl && candLbl) {
          if (candLbl === stepLbl) score += 42;
          else if (candLbl.includes(stepLbl) || stepLbl.includes(candLbl)) score += 24;
        }
        if (stepAcc && candAcc && stepAcc !== stepLbl) {
          if (candAcc === stepAcc) score += 32;
          else if (candAcc.includes(stepAcc) || stepAcc.includes(candAcc)) score += 18;
        }
        if (stepId && candId && stepId === candId) score += 28;
        if (stepName && candName && stepName === candName) score += 22;
        if (stepHref && candHref && stepHref === candHref) score += 30;
        if (stepSec && candSec) {
          if (candSec === stepSec) score += 18;
          else if (candSec.includes(stepSec) || stepSec.includes(candSec)) score += 10;
        }
        if (stepRole && candRole === stepRole) score += 12;

        if (score > bestScore) {
          bestScore = score;
          best = { element: el, signature: sig, score };
        }
      }

      return best && bestScore >= 32 ? best : null;
    }

    async executeLearnedSkill(skill, opts = {}) {
      if (!skill || !Array.isArray(skill.steps) || skill.steps.length === 0) {
        return { status: 'invalid_skill', verified: false, message: 'Skill has no executable steps.' };
      }
      const doc = this._getDoc();
      const mem = this._getMemory();
      const startIdx = Math.max(0, Number(opts.fromStepIndex) || 0);

      for (let i = startIdx; i < skill.steps.length; i++) {
        const step = skill.steps[i];
        const hit = this.reidentifyStepElement(step, doc);
        if (!hit || !hit.element) {
          if (mem && typeof mem.recordLearnedSkillOutcome === 'function') {
            await mem.recordLearnedSkillOutcome(skill.id, { ok: false });
          }
          return {
            status: 'skill_step_failed',
            verified: false,
            failedStepIndex: i,
            failedStep: step,
            skill,
            message: `Step ${i + 1} ("${step.label || step.role}") could not be re-identified on the current page.`
          };
        }

        const el = hit.element;
        const tag = String(el.tagName || '').toLowerCase();
        const isLast = i === skill.steps.length - 1;
        const curHrefBefore = doc && doc.location ? doc.location.href : '';

        // If clicking an <a href> link inside a multi-step flow that navigates, arm pending continuation first!
        if (!isLast && mem && mem.state && tag === 'a' && getAttr(el, 'href') && !String(getAttr(el, 'href')).startsWith('#')) {
          mem.state.pendingSkillReplay = {
            skillId: skill.id,
            nextStepIndex: i + 1,
            startedAt: Date.now(),
            utterance: opts.utterance || skill.instruction
          };
          await mem.saveState({ skipTabSync: true }).catch(() => {});
        }

        try {
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'auto', block: 'center' });
          if (step.action === 'select' && tag === 'select') {
            const wantLow = norm(step.value || '');
            const optArr = Array.from(el.options || []);
            const matchedOpt = optArr.find((o) => norm(o.text || o.label) === wantLow || norm(o.value) === wantLow);
            if (!matchedOpt) {
              if (mem) await mem.recordLearnedSkillOutcome(skill.id, { ok: false });
              return { status: 'skill_step_failed', verified: false, failedStepIndex: i, failedStep: step, skill, message: `Option "${step.value}" no longer exists in "${step.label}".` };
            }
            el.value = matchedOpt.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (step.action === 'fill' && (tag === 'input' || tag === 'textarea')) {
            if (!step.sensitive && step.value) {
              el.value = step.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else if (step.action === 'check' && tag === 'input') {
            if (!el.checked && typeof el.click === 'function') el.click();
            if (!el.checked) {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else if (step.action === 'uncheck' && tag === 'input') {
            if (el.checked && typeof el.click === 'function') el.click();
            if (el.checked) {
              el.checked = false;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            if (typeof el.click === 'function') el.click();
          }
        } catch (err) {
          if (mem) await mem.recordLearnedSkillOutcome(skill.id, { ok: false });
          return { status: 'skill_step_failed', verified: false, failedStepIndex: i, failedStep: step, skill, message: (err && err.message) || 'Step execution failed.' };
        }

        await new Promise((r) => setTimeout(r, 140));
        if (this.controller && this.controller.worldModel) {
          await this.controller.worldModel.observeTab(doc, { force: true }).catch(() => {});
        }

        // If navigation happened in-flight without destroying script (SPA), URL changed cleanly
        const curHrefAfter = doc && doc.location ? doc.location.href : '';
        if (!isLast && curHrefAfter !== curHrefBefore && mem && mem.state && mem.state.pendingSkillReplay) {
          mem.state.pendingSkillReplay = null;
          await mem.saveState({ skipTabSync: true }).catch(() => {});
        }
      }

      if (mem && mem.state && mem.state.pendingSkillReplay) {
        mem.state.pendingSkillReplay = null;
        await mem.saveState({ skipTabSync: true }).catch(() => {});
      }
      if (mem && typeof mem.recordLearnedSkillOutcome === 'function') {
        await mem.recordLearnedSkillOutcome(skill.id, { ok: true });
      }
      const msg = `Completed learned workflow "${skill.name}" (${skill.steps.length} step${skill.steps.length === 1 ? '' : 's'}).`;
      if (this.controller && typeof this.controller.setAssistantReply === 'function') this.controller.setAssistantReply(msg);
      if (typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({ type: 'answer', title: `Skill: ${skill.name}`, text: msg });
      }
      if (this.controller && this.controller.reader) this.controller.reader.readText(msg);
      return { status: 'skill_executed', verified: true, skillId: skill.id, version: skill.version, answer: msg };
    }

    promptRelearnOffer(failRes, rawCommand = '') {
      const sk = failRes && failRes.skill;
      if (!sk) return this.promptTeachOffer({ command: rawCommand, reason: (failRes && failRes.message) || '' });
      const msg = `${failRes.message} Would you like to teach me the updated steps?`;
      const startRelearn = () => this.startTeaching(sk.instruction || rawCommand, { mode: 'relearn', baseSkillId: sk.id });

      if (typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.setState('confirm');
        window.SW_UI.showCard({
          type: 'choices',
          title: 'Workflow Changed — Relearn?',
          text: msg,
          choices: ['Teach Updated Steps', 'Cancel'],
          actions: [
            { id: 'relearn', label: 'Teach Updated Steps', primary: true },
            { id: 'cancel', label: 'Cancel' }
          ],
          onAction: async (actId, d) => {
            if (actId === 'relearn' || (actId === 'choose' && d && d.index === 0)) return await startRelearn();
            if (this.controller && typeof this.controller.cancelActiveTask === 'function') this.controller.cancelActiveTask('Cancelled.');
          }
        });
      }
      if (this.controller && typeof this.controller._enterWaitingForClarification === 'function') {
        const tId = (this.controller.taskLifecycle && this.controller.taskLifecycle.activeTaskId) || Date.now();
        this.controller._enterWaitingForClarification(tId, msg, async (replyText, info) => {
          const low = norm(replyText);
          if (/^(?:please\s+)?(?:teach|relearn|update|yes|show(?:\s+me)?|1)\.?$/i.test(low) ||
              /\b(?:teach\s+updated\s+steps|relearn\s+(?:workflow|skill))\b/i.test(low)) {
            return await startRelearn();
          }
          if (/^(?:cancel|no|nope|nah|dismiss|close|stop|never\s*mind|no\s*need|leave\s*it|forget\s*it|2)\.?$/i.test(low)) {
            if (this.controller && typeof this.controller.cancelActiveTask === 'function') this.controller.cancelActiveTask('Cancelled.');
            return { status: 'task_cancelled', answer: 'Cancelled.' };
          }
          if (typeof window !== 'undefined' && window.SW_UI && typeof window.SW_UI.hideCard === 'function') {
            window.SW_UI.hideCard();
          }
          if (this.controller && typeof this.controller._processUserInputInner === 'function') {
            return this.controller._processUserInputInner(replyText, (info && info.inputSource) || 'voice', {
              ...((info && info.meta) || {}),
              internalResumeTaskId: (info && info.taskId) || tId
            });
          }
          if (this.controller && typeof this.controller.cancelActiveTask === 'function') this.controller.cancelActiveTask('Cancelled.');
          return { status: 'task_cancelled', answer: 'Cancelled.' };
        });
      }
      return { status: 'needs_clarification', offerRelearn: true, message: msg };
    }
  }

  rootScope.SleepwalkerTeach = SleepwalkerTeach;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SleepwalkerTeach;
  }
})(typeof window !== 'undefined' ? window : globalThis);
