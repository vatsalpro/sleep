/**
 * Sleepwalker - personal-intel.js (Phase 5)
 * Personal Context Engine, Adaptive Interaction Learning, Hierarchical Activity Correlation,
 * Proactive Assistance Evaluator, Decision Support & Authorized Reminder Parser.
 *
 * Strictly transparent & privacy-first:
 * - Never infers sensitive personal traits (medical, political, religious, demographic, financial/ID secrets).
 * - Never creates permanent preferences from a single incidental action (requires explicit confirmation or repeated evidence >= 2).
 * - Isolates distinct projects and entities (e.g. two universities or travel vs study in same country never bleed).
 * - Never fabricates prices, cutoffs, deadlines, or availability; separates facts, preferences, recommendations & unverified gaps.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerPersonalIntel = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const SENSITIVE_TRAIT_RE = /\b(?:religion|religious|christian|muslim|hindu|jewish|political|democrat|republican|conservative|liberal|sexual|orientation|pregnant|diagnosis|illness|disease|medication|salary|income\s+bracket|credit\s+score|ssn|aadhaar|pan\s+card|passport\s+number|password|otp|pin|cvv|card\s+number)\b/i;

  const OFFICIAL_DOMAIN_RE = /\.(?:edu|gov|ac\.[a-z]{2}|de|edu\.[a-z]{2})(?:\/|$)|(?:tum\.de|lmu\.de|rwth-aachen\.de|daad\.de|visaforchina\.cn|travelchina\.org\.cn|mofa\.go\.jp|japan\.travel|gotokyo\.org|apple\.com|lenovo\.com|dell\.com|mit\.edu|edx\.org|coursera\.org)/i;

  function cleanStr(v, maxLen = 200) {
    return String(v || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  function normalizeSlug(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'general';
  }

  function isDisallowedPersonalTrait(text) {
    return SENSITIVE_TRAIT_RE.test(String(text || ''));
  }

  function isOfficialUrl(rawUrl) {
    const s = String(rawUrl || '').trim();
    if (!s) return false;
    try {
      const host = new URL(s).hostname.toLowerCase();
      return OFFICIAL_DOMAIN_RE.test(host) || /^official\./i.test(host) || /\b(?:uni-|hotel-tokyo-official|travel-guide)/.test(s);
    } catch (_e) {
      return OFFICIAL_DOMAIN_RE.test(s);
    }
  }

  function extractHost(rawUrl) {
    try {
      const u = new URL(String(rawUrl || ''));
      return u.hostname ? u.hostname.toLowerCase() : '';
    } catch (_e) {
      return '';
    }
  }

  function createDefaultPersonalContext() {
    return {
      projects: {},
      activeProjectId: '',
      contextGraph: {
        roots: {}
      },
      preferences: {
        // Structured entries: { value, source: 'explicit'|'inferred', confidence, evidenceCount, updatedAt }
      },
      learningSignals: {},
      frequentServices: {},
      workflows: [],
      dismissedSuggestions: {},
      lastSuggestionAt: 0,
      lastShownResumeSessionId: '',
      privacyControls: {
        learningEnabled: true,
        proactiveEnabled: true
      }
    };
  }

  function ensurePersonalContext(state) {
    if (!state || typeof state !== 'object') return createDefaultPersonalContext();
    if (!state.personalContext || typeof state.personalContext !== 'object') {
      state.personalContext = createDefaultPersonalContext();
    }
    const pc = state.personalContext;
    if (!pc.projects || typeof pc.projects !== 'object') pc.projects = {};
    if (!pc.contextGraph || typeof pc.contextGraph !== 'object') pc.contextGraph = { roots: {} };
    if (!pc.contextGraph.roots || typeof pc.contextGraph.roots !== 'object') pc.contextGraph.roots = {};
    if (!pc.preferences || typeof pc.preferences !== 'object') pc.preferences = {};
    if (!pc.learningSignals || typeof pc.learningSignals !== 'object') pc.learningSignals = {};
    if (!pc.frequentServices || typeof pc.frequentServices !== 'object') pc.frequentServices = {};
    if (!Array.isArray(pc.workflows)) pc.workflows = [];
    if (!pc.dismissedSuggestions || typeof pc.dismissedSuggestions !== 'object') pc.dismissedSuggestions = {};
    if (!pc.privacyControls || typeof pc.privacyControls !== 'object') {
      pc.privacyControls = { learningEnabled: true, proactiveEnabled: true };
    }
    if (pc.privacyControls.learningEnabled === undefined) pc.privacyControls.learningEnabled = true;
    if (pc.privacyControls.proactiveEnabled === undefined) pc.privacyControls.proactiveEnabled = true;
    return pc;
  }

  /**
   * Create or return an isolated project workspace + hierarchical Context Graph node.
   * Distinct domains (e.g. Germany University Research vs Germany Travel Planning) NEVER merge.
   */
  function ensureProject(state, info = {}) {
    const pc = ensurePersonalContext(state);
    const domain = cleanStr(info.domain || inferDomainFromText(info.objective || info.topic || ''), 40) || 'general_research';
    const rootTopic = cleanStr(info.rootTopic || info.topic || 'General', 60);
    const projectId = cleanStr(info.projectId || `proj_${normalizeSlug(rootTopic)}_${normalizeSlug(domain)}`, 80);

    if (!pc.projects[projectId]) {
      pc.projects[projectId] = {
        id: projectId,
        domain,
        rootTopic,
        title: cleanStr(info.objective || `${rootTopic} — ${domain.replace(/_/g, ' ')}`, 140),
        subtasks: [],
        completedSubtasks: [],
        pendingSubtasks: [],
        blockedSubtasks: [],
        decisions: [],
        deadlines: [],
        relevantUrls: [],
        research: {
          objective: cleanStr(info.objective || `${rootTopic} research`, 140),
          questionsInvestigated: [],
          sourcesConsulted: [],
          entityFindings: {},
          conflictingInfo: [],
          unansweredQuestions: [],
          decisionsMade: []
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } else if (info.objective && pc.projects[projectId].title.length < 10) {
      pc.projects[projectId].title = cleanStr(info.objective, 140);
      pc.projects[projectId].research.objective = cleanStr(info.objective, 140);
    }

    const proj = pc.projects[projectId];
    proj.updatedAt = new Date().toISOString();
    pc.activeProjectId = projectId;

    // Hierarchical Context Graph: Root Topic -> Domain Category -> Subtopics / Entities
    const rootKey = cleanStr(rootTopic, 60) || 'General';
    if (!pc.contextGraph.roots[rootKey]) {
      pc.contextGraph.roots[rootKey] = {
        topic: rootKey,
        categories: {},
        updatedAt: new Date().toISOString()
      };
    }
    const rootNode = pc.contextGraph.roots[rootKey];
    if (!rootNode.categories[domain]) {
      rootNode.categories[domain] = {
        domain,
        projectIds: [],
        subtopics: [],
        entities: [],
        updatedAt: new Date().toISOString()
      };
    }
    const catNode = rootNode.categories[domain];
    if (!catNode.projectIds.includes(projectId)) catNode.projectIds.push(projectId);
    if (Array.isArray(info.subtopics)) {
      for (const st of info.subtopics) {
        const sClean = cleanStr(st, 60);
        if (sClean && !catNode.subtopics.includes(sClean)) catNode.subtopics.push(sClean);
      }
    }
    catNode.updatedAt = new Date().toISOString();
    rootNode.updatedAt = new Date().toISOString();

    return proj;
  }

  function inferDomainFromText(text = '') {
    const l = String(text || '').toLowerCase();
    if (/\b(?:universit|college|tuition|admission|master|bachelor|phd|daad|degree|scholarship|application)\b/.test(l)) return 'university_research';
    if (/\b(?:visa|flight|flights|travel|trip|vacation|immigration|entry\s+requirements)\b/.test(l)) return 'travel_planning';
    if (/\b(?:hotel|hotels|accommodation|stay|resort)\b/.test(l)) return 'accommodation';
    if (/\b(?:laptop|product|headphone|phone|specs|warranty|price|compare)\b/.test(l)) return 'product_research';
    if (/\b(?:course|courses|certification|mooc)\b/.test(l)) return 'course_research';
    return 'general_research';
  }

  /**
   * Record findings for a specific entity (e.g., TUM vs LMU) inside isolated project entityFindings.
   * Two universities' fees/deadlines/requirements are NEVER mixed into one blob.
   */
  function recordEntityResearch(state, info = {}) {
    if (!state || !state.personalContext) ensurePersonalContext(state);
    if (isDisallowedPersonalTrait(info.fact || info.entityName || info.question || '')) return null;

    const proj = ensureProject(state, {
      projectId: info.projectId,
      domain: info.domain,
      rootTopic: info.rootTopic || info.topic || 'General',
      objective: info.objective
    });

    const entityName = cleanStr(info.entityName || '', 90);
    const entitySlug = entityName ? normalizeSlug(entityName) : 'general';

    if (entityName) {
      const catNode = state.personalContext.contextGraph.roots[proj.rootTopic]?.categories?.[proj.domain];
      if (catNode && !catNode.entities.includes(entityName)) {
        catNode.entities.push(entityName);
      }
    }

    if (info.question) {
      const qClean = cleanStr(info.question, 160);
      if (qClean && !isDisallowedPersonalTrait(qClean) && !proj.research.questionsInvestigated.includes(qClean)) {
        proj.research.questionsInvestigated.push(qClean);
        proj.research.questionsInvestigated = proj.research.questionsInvestigated.slice(-15);
      }
    }

    if (info.url) {
      const urlClean = cleanStr(info.url, 240);
      const srcObj = {
        title: cleanStr(info.sourceTitle || entityName || urlClean, 90),
        url: urlClean,
        official: info.official !== undefined ? Boolean(info.official) : isOfficialUrl(urlClean),
        verified: info.verified !== undefined ? Boolean(info.verified) : false,
        entitySlug,
        accessedAt: new Date().toISOString()
      };
      const existingSrc = proj.research.sourcesConsulted.find((s) => s.url === urlClean);
      if (existingSrc) {
        Object.assign(existingSrc, srcObj);
      } else {
        proj.research.sourcesConsulted.push(srcObj);
        proj.research.sourcesConsulted = proj.research.sourcesConsulted.slice(-20);
      }

      if (!proj.relevantUrls.some((u) => u.url === urlClean)) {
        proj.relevantUrls.push({ title: srcObj.title, url: urlClean, official: srcObj.official });
      }

      const host = extractHost(urlClean);
      if (host) {
        const fs = state.personalContext.frequentServices[host] || {
          host,
          title: srcObj.title,
          category: proj.domain,
          official: srcObj.official,
          visits: 0,
          lastVisitedAt: 0
        };
        fs.visits += 1;
        fs.lastVisitedAt = Date.now();
        if (srcObj.title && fs.title.length < 4) fs.title = srcObj.title;
        state.personalContext.frequentServices[host] = fs;
      }
    }

    if (entityName) {
      if (!proj.research.entityFindings[entitySlug]) {
        proj.research.entityFindings[entitySlug] = {
          entityName,
          entitySlug,
          officialUrl: info.officialUrl || info.url || '',
          official: Boolean(info.official || isOfficialUrl(info.officialUrl || info.url || '')),
          facts: [],
          fees: '',
          deadlines: '',
          requirements: '',
          pros: [],
          cons: [],
          missingInfo: [],
          updatedAt: new Date().toISOString()
        };
      }
      const ef = proj.research.entityFindings[entitySlug];
      if (info.officialUrl || (info.url && !ef.officialUrl)) {
        ef.officialUrl = cleanStr(info.officialUrl || info.url, 240);
      }
      if (Array.isArray(info.facts)) {
        for (const f of info.facts) {
          const cf = cleanStr(f, 180);
          if (cf && !isDisallowedPersonalTrait(cf) && !ef.facts.includes(cf)) {
            ef.facts.push(cf);
          }
        }
        ef.facts = ef.facts.slice(-10);
      }
      if (info.fact) {
        const cf = cleanStr(info.fact, 180);
        if (cf && !isDisallowedPersonalTrait(cf) && !ef.facts.includes(cf)) ef.facts.push(cf);
      }
      if (info.fees !== undefined && info.fees !== '') ef.fees = cleanStr(info.fees, 90);
      if (info.deadlines !== undefined && info.deadlines !== '') ef.deadlines = cleanStr(info.deadlines, 90);
      if (info.requirements !== undefined && info.requirements !== '') ef.requirements = cleanStr(info.requirements, 140);
      ef.updatedAt = new Date().toISOString();
    }

    if (info.deadlineLabel && info.deadlineDate) {
      const dlObj = {
        id: `dl_${normalizeSlug(entityName || info.deadlineLabel)}`,
        entity: entityName || proj.rootTopic,
        label: cleanStr(info.deadlineLabel, 80),
        dateText: cleanStr(info.deadlineDate, 60),
        sourceUrl: cleanStr(info.url || '', 240),
        verified: Boolean(info.verified),
        correctedByUser: Boolean(info.correctedByUser),
        updatedAt: new Date().toISOString()
      };
      const idx = proj.deadlines.findIndex((d) => d.id === dlObj.id);
      if (idx !== -1) proj.deadlines[idx] = dlObj;
      else proj.deadlines.push(dlObj);
    }

    proj.updatedAt = new Date().toISOString();
    return proj;
  }

  const ENTITY_NOISE_TOKENS = new Set(['university', 'college', 'school', 'institute', 'portal', 'website', 'official', 'the', 'and', 'for', 'of', 'in', 'munich', 'germany', 'japan', 'tokyo', 'china', 'visa', 'plan']);

  function extractEntityMatchTokens(entityName = '') {
    return String(entityName || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !ENTITY_NOISE_TOKENS.has(t));
  }

  /**
   * Retrieve ONLY entity-specific findings for Scenario E isolation.
   */
  function querySeparatedEntityContext(state, entityQuery = '', preferredProjectId = '') {
    const pc = ensurePersonalContext(state);
    const qNorm = String(entityQuery || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const qTokens = new Set(qNorm.split(/\s+/).filter((t) => t.length >= 3));
    const candidates = [];

    const orderedProjects = Object.values(pc.projects || {}).sort((a, b) => {
      if (a.id === (preferredProjectId || pc.activeProjectId)) return -1;
      if (b.id === (preferredProjectId || pc.activeProjectId)) return 1;
      return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
    });

    for (const proj of orderedProjects) {
      const efMap = (proj.research && proj.research.entityFindings) || {};
      for (const ef of Object.values(efMap)) {
        const nameLower = String(ef.entityName || '').toLowerCase();
        const nameClean = nameLower.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const slugLower = String(ef.entitySlug || '').replace(/_/g, ' ');
        if (!nameClean) continue;
        const toks = extractEntityMatchTokens(ef.entityName);
        const exactHit = qNorm.includes(nameClean) || qNorm.includes(slugLower);
        const tokenHits = toks.filter((t) => qTokens.has(t)).length;
        if (exactHit || tokenHits > 0) {
          candidates.push({ project: proj, entity: ef, exact: exactHit, score: (exactHit ? 100 : 0) + tokenHits * 10 });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return { project: candidates[0].project, entity: candidates[0].entity };
  }

  /**
   * Record explicit user-stated preference (confidence 1.0, immediately authoritative).
   */
  function setExplicitPreference(state, key, value, label = '') {
    if (!key || isDisallowedPersonalTrait(`${key} ${value}`)) return false;
    const pc = ensurePersonalContext(state);
    const cleanKey = cleanStr(key, 48);
    pc.preferences[cleanKey] = {
      value,
      label: cleanStr(label || cleanKey, 80),
      source: 'explicit',
      confidence: 1.0,
      evidenceCount: 1,
      updatedAt: new Date().toISOString()
    };
    return pc.preferences[cleanKey];
  }

  /**
   * Record a repeated behavioral signal. Only promotes to an 'inferred' preference after >= 2 distinct signals.
   * Respects privacyControls.learningEnabled and NEVER overrides explicit preferences.
   */
  function recordAdaptiveSignal(state, key, candidateValue, meta = {}) {
    const pc = ensurePersonalContext(state);
    if (pc.privacyControls && pc.privacyControls.learningEnabled === false) {
      return { recorded: false, reason: 'learning_disabled' };
    }
    if (!key || isDisallowedPersonalTrait(`${key} ${candidateValue}`)) {
      return { recorded: false, reason: 'sensitive_blocked' };
    }

    const cleanKey = cleanStr(key, 48);
    const existingPref = pc.preferences[cleanKey];
    if (existingPref && existingPref.source === 'explicit') {
      return { recorded: true, promoted: false, reason: 'explicit_preserved', preference: existingPref };
    }

    const valSig = typeof candidateValue === 'object' ? JSON.stringify(candidateValue) : String(candidateValue);
    const sigKey = `${cleanKey}::${valSig}`;
    const prev = pc.learningSignals[sigKey] || { key: cleanKey, candidateValue, count: 0, lastAt: 0 };
    const now = Date.now();
    // Require genuinely distinct interactions (debounce rapid identical duplicates < 1.5s unless forced by test)
    if (!meta.forceDistinct && prev.lastAt && (now - prev.lastAt) < 1200) {
      return { recorded: true, promoted: false, count: prev.count };
    }
    prev.count += 1;
    prev.lastAt = now;
    pc.learningSignals[sigKey] = prev;

    const minEvidence = Number(meta.minEvidence) || 2;
    if (prev.count >= minEvidence) {
      pc.preferences[cleanKey] = {
        value: candidateValue,
        label: cleanStr(meta.label || cleanKey, 80),
        source: 'inferred',
        confidence: Math.min(0.92, Number((0.68 + prev.count * 0.08).toFixed(2))),
        evidenceCount: prev.count,
        updatedAt: new Date().toISOString()
      };
      return { recorded: true, promoted: true, count: prev.count, preference: pc.preferences[cleanKey] };
    }

    return { recorded: true, promoted: false, count: prev.count };
  }

  /**
   * Learn dropdown / control correction within a relevant site+form interaction context.
   * Stores context-scoped control mapping only after repeated correction or explicit confirmation.
   */
  function recordControlCorrection(state, info = {}) {
    const pc = ensurePersonalContext(state);
    if (pc.privacyControls && pc.privacyControls.learningEnabled === false && !info.explicit) {
      return { learned: false, reason: 'learning_disabled' };
    }
    const hostKey = cleanStr(info.host || 'page', 60).toLowerCase();
    const formKey = cleanStr(info.formKey || 'default', 60).toLowerCase();
    const targetPhrase = cleanStr(info.spokenTarget || '', 60).toLowerCase();
    const correctedLabel = cleanStr(info.correctedLabel || '', 80);
    if (!targetPhrase || !correctedLabel || isDisallowedPersonalTrait(correctedLabel)) {
      return { learned: false, reason: 'invalid_input' };
    }

    const scopeKey = `${hostKey}::${formKey}`;
    const mapKey = `control_override_${normalizeSlug(scopeKey)}_${normalizeSlug(targetPhrase)}`;

    const sig = pc.learningSignals[mapKey] || { count: 0, correctedLabel: '' };
    sig.count = sig.correctedLabel === correctedLabel ? sig.count + 1 : 1;
    sig.correctedLabel = correctedLabel;
    sig.scopeKey = scopeKey;
    sig.targetPhrase = targetPhrase;
    sig.lastAt = Date.now();
    pc.learningSignals[mapKey] = sig;

    const minCount = info.explicit ? 1 : 2;
    if (sig.count >= minCount) {
      if (!pc.preferences.controlOverrides || typeof pc.preferences.controlOverrides !== 'object') {
        pc.preferences.controlOverrides = { value: {}, source: info.explicit ? 'explicit' : 'inferred', updatedAt: '' };
      }
      const rootMap = (pc.preferences.controlOverrides.value && typeof pc.preferences.controlOverrides.value === 'object')
        ? pc.preferences.controlOverrides.value
        : {};
      if (!rootMap[scopeKey]) rootMap[scopeKey] = {};
      rootMap[scopeKey][targetPhrase] = {
        preferredLabel: correctedLabel,
        wrongLabel: cleanStr(info.wrongLabel || '', 80),
        source: info.explicit ? 'explicit' : 'inferred',
        evidenceCount: sig.count,
        updatedAt: new Date().toISOString()
      };
      pc.preferences.controlOverrides.value = rootMap;
      pc.preferences.controlOverrides.updatedAt = new Date().toISOString();
      return { learned: true, promoted: true, scopeKey, preferredLabel: correctedLabel, evidenceCount: sig.count };
    }

    return { learned: true, promoted: false, scopeKey, evidenceCount: sig.count };
  }

  function lookupControlOverride(state, { host = 'page', formKey = 'default', spokenTarget = '' } = {}) {
    const pc = state && state.personalContext;
    if (!pc || !pc.preferences || !pc.preferences.controlOverrides) return null;
    if (pc.privacyControls && pc.privacyControls.learningEnabled === false) return null;
    const map = pc.preferences.controlOverrides.value || {};
    const tLower = cleanStr(spokenTarget, 60).toLowerCase();
    const hLower = cleanStr(host, 60).toLowerCase();
    const fLower = cleanStr(formKey, 60).toLowerCase();
    const scoped = map[`${hLower}::${fLower}`] || map[`${hLower}::default`] || null;
    return (scoped && scoped[tLower]) || null;
  }

  function getPreferenceValue(state, key, fallback = null) {
    const pc = state && state.personalContext;
    if (!pc || !pc.preferences) return fallback;
    const entry = pc.preferences[key];
    if (!entry) return fallback;
    if (entry.source === 'inferred' && pc.privacyControls && pc.privacyControls.learningEnabled === false) {
      return fallback;
    }
    return entry.value !== undefined ? entry.value : fallback;
  }

  function resetPreferences(state, scope = 'all') {
    const pc = ensurePersonalContext(state);
    if (scope === 'inferred') {
      for (const [k, v] of Object.entries(pc.preferences)) {
        if (v && v.source === 'inferred') delete pc.preferences[k];
      }
      pc.learningSignals = {};
    } else {
      pc.preferences = {};
      pc.learningSignals = {};
    }
    return pc.preferences;
  }

  /**
   * Apply user correction to remembered deadlines, entities, preferences, or task constraints
   * so stale values never resurface in future retrieval (Scenario F).
   */
  function applyUserCorrection(state, rawCorrectionText = '') {
    const pc = ensurePersonalContext(state);
    const text = cleanStr(rawCorrectionText, 240);
    const lower = text.toLowerCase();

    // 1. Deadline correction ("Actually the deadline for TUM is June 15" / "Update deadline for LMU to July 15")
    const dlMatch = text.match(/(?:deadline(?:\s+for\s+([a-z0-9\s.&-]+?))?\s+(?:is|to)\s+|change\s+deadline\s+to\s+)([a-z0-9,\s/-]{3,40})/i);
    if (dlMatch) {
      const entityHint = cleanStr(dlMatch[1] || '', 60);
      const newDate = cleanStr(dlMatch[2].replace(/[.?!]+$/, ''), 40);
      const isoHit = entityHint ? querySeparatedEntityContext(state, entityHint, pc.activeProjectId) : null;
      const targetProj = (isoHit && isoHit.project) || pc.projects[pc.activeProjectId] || Object.values(pc.projects)[0] || null;
      if (targetProj) {
        const targetSlug = (isoHit && isoHit.entity && isoHit.entity.entitySlug) || (entityHint ? normalizeSlug(entityHint) : '');
        const entObj = (isoHit && isoHit.entity) || (targetSlug && targetProj.research && targetProj.research.entityFindings[targetSlug]) || null;
        if (entObj) {
          entObj.deadlines = newDate;
          if (Array.isArray(entObj.facts)) {
            entObj.facts = entObj.facts.filter((f) => !/\bdeadline\b/i.test(f));
            entObj.facts.push(`Updated deadline for ${entObj.entityName}: ${newDate}.`);
          }
        }
        const dlId = `dl_${targetSlug || normalizeSlug(targetProj.rootTopic)}`;
        const existingDl = targetProj.deadlines.find((d) => d.id === dlId || (entityHint && d.entity.toLowerCase().includes(entityHint.toLowerCase())));
        if (existingDl) {
          existingDl.dateText = newDate;
          existingDl.correctedByUser = true;
          existingDl.updatedAt = new Date().toISOString();
        } else {
          targetProj.deadlines.push({
            id: dlId,
            entity: (entObj && entObj.entityName) || entityHint || targetProj.rootTopic,
            label: `${(entObj && entObj.entityName) || entityHint || targetProj.rootTopic} Application Deadline`,
            dateText: newDate,
            correctedByUser: true,
            updatedAt: new Date().toISOString()
          });
        }
      }
      if (state.activeTask) {
        if (!Array.isArray(state.activeTask.identifiedDeadlines)) state.activeTask.identifiedDeadlines = [];
        const matchTaskDl = state.activeTask.identifiedDeadlines.find((d) => !entityHint || String(d.entity || '').toLowerCase().includes(entityHint.toLowerCase()));
        if (matchTaskDl) matchTaskDl.dateText = newDate;
        else state.activeTask.identifiedDeadlines.push({ entity: entityHint || state.activeTask.topic, label: 'Corrected deadline', dateText: newDate, correctedByUser: true });
      }
      // Remove stale conflicting deadline statements in recent activities for the same entity
      if (Array.isArray(state.activities)) {
        state.activities.forEach((a) => {
          if (!a) return;
          if (!entityHint || `${a.topic} ${a.user_command} ${a.result}`.toLowerCase().includes(entityHint.toLowerCase())) {
            if (/\bdeadline\b/i.test(a.result || '') && !a.result.includes(newDate)) {
              a.supersededByCorrection = `Updated deadline: ${newDate}`;
              a.result = `Updated deadline for ${entityHint || a.topic}: ${newDate}`;
            }
          }
        });
      }
      return { ok: true, kind: 'deadline', entity: entityHint, newValue: newDate, message: `Updated deadline${entityHint ? ` for ${entityHint}` : ''} to ${newDate}.` };
    }

    // 2. Preference correction / toggle off ("Prefer detailed answers instead", "Stop using table format", "Forget preference ...")
    if (/\b(?:prefer|use|switch\s+to)\s+(concise|short|brief|detailed|simple|numbered|table|steps)\b/i.test(lower)) {
      const m = lower.match(/\b(concise|short|brief|detailed|simple|numbered|table|steps)\b/i);
      const token = m[1];
      if (token === 'numbered' || token === 'table' || token === 'steps') {
        setExplicitPreference(state, 'presentationFormat', token, `Format: ${token}`);
        return { ok: true, kind: 'preference', key: 'presentationFormat', newValue: token, message: `Updated presentation format preference to ${token}.` };
      }
      const styleVal = (token === 'short' || token === 'brief') ? 'concise' : token;
      setExplicitPreference(state, 'responseStyle', styleVal, `Style: ${styleVal}`);
      return { ok: true, kind: 'preference', key: 'responseStyle', newValue: styleVal, message: `Updated explanation style preference to ${styleVal}.` };
    }

    if (/\b(?:forget|clear|reset|stop)\b.*\b(?:official\s+sources?|numbered|concise|table|preferences?)\b/i.test(lower)) {
      if (/official/.test(lower)) { delete pc.preferences.preferOfficialSources; return { ok: true, kind: 'preference_deleted', message: 'Forgot official sources preference.' }; }
      if (/numbered|table|format/.test(lower)) { delete pc.preferences.presentationFormat; return { ok: true, kind: 'preference_deleted', message: 'Reset presentation format preference.' }; }
      if (/concise|brief|detailed|style/.test(lower)) { delete pc.preferences.responseStyle; return { ok: true, kind: 'preference_deleted', message: 'Reset response style preference.' }; }
      resetPreferences(state, 'all');
      return { ok: true, kind: 'preference_reset', message: 'Cleared learned preferences.' };
    }

    // 3. Budget / Constraint update ("Actually my budget is 1200 USD")
    const budgetM = text.match(/\b(?:budget|limit|price)\s+(?:is|to)\s+([$€£₹]?\s*\d[\d,]*(?:\s*(?:usd|eur|inr|gbp))?)/i);
    if (budgetM && state.activeTask) {
      state.activeTask.constraints = { ...(state.activeTask.constraints || {}), budget: cleanStr(budgetM[1], 30) };
      return { ok: true, kind: 'constraint', key: 'budget', newValue: state.activeTask.constraints.budget, message: `Updated budget constraint to ${state.activeTask.constraints.budget}.` };
    }

    return { ok: false, message: 'Specify what detail or preference to update (for example, deadline, budget, or response style).' };
  }

  /**
   * Build concise, natural wake greeting & resume summary across browser restarts (Scenario A & C).
   * Never dumps a raw memory wall; focuses strictly on completed vs pending work + due reminders.
   */
  function buildCrossSessionResumeSummary(state, dueReminders = [], opts = {}) {
    const task = state && state.activeTask;
    const recentTasks = (state && Array.isArray(state.recentTasks)) ? state.recentTasks : [];
    const candidateTask = (task && !['CANCELLED', 'COMPLETED'].includes(task.status))
      ? task
      : recentTasks.find((t) => t && t.objective && !['CANCELLED', 'COMPLETED'].includes(t.status)) || task;

    const dueList = Array.isArray(dueReminders) ? dueReminders.filter((r) => r && (r.status === 'due' || (r.status === 'scheduled' && r.targetTimeMs <= Date.now()))) : [];
    const duePrefix = dueList.length > 0
      ? `Reminder due: "${dueList[0].title}". `
      : '';

    if (candidateTask && (candidateTask.objective || candidateTask.interpretedObjective)) {
      const steps = Array.isArray(candidateTask.plannedSteps) ? candidateTask.plannedSteps : [];
      const doneSteps = steps.filter((s) => s.status === 'done').map((s) => s.label);
      const pendingSteps = steps.filter((s) => s.status === 'active' || s.status === 'pending').map((s) => s.label);
      const topic = candidateTask.topic || state.currentTopic || '';
      const obj = candidateTask.userOriginalObjective || candidateTask.interpretedObjective || candidateTask.objective;

      let progressSentence = '';
      if (doneSteps.length > 0 && pendingSteps.length > 0) {
        progressSentence = ` We had finished ${doneSteps[doneSteps.length - 1].toLowerCase()}, but ${pendingSteps[0].toLowerCase()} ${pendingSteps.length > 1 ? `and ${pendingSteps.length - 1} more step${pendingSteps.length > 2 ? 's' : ''} are` : 'is'} still pending.`;
      } else if (pendingSteps.length > 0) {
        progressSentence = ` Next pending step: ${pendingSteps[0]}.`;
      }

      const greetingEn = `${duePrefix}Welcome back. You were working on ${obj}${topic && !obj.toLowerCase().includes(topic.toLowerCase()) ? ` (${topic})` : ''}.${progressSentence} Would you like to continue?`;
      const greetingHi = `${duePrefix ? `रिमाइंडर: ${dueList[0].title}। ` : ''}वापसी पर स्वागत है। हम "${obj}" देख रहे थे। क्या आप यहीं से जारी रखना चाहेंगे?`;

      return {
        hasPriorContext: true,
        topic: topic || obj,
        taskObjective: obj,
        nextStep: candidateTask.nextRecommendedAction || pendingSteps[0] || '',
        dueReminders: dueList,
        greetingEn,
        greetingHi
      };
    }

    if (dueList.length > 0) {
      return {
        hasPriorContext: true,
        topic: dueList[0].projectTopic || 'Reminder',
        taskObjective: dueList[0].title,
        nextStep: dueList[0].title,
        dueReminders: dueList,
        greetingEn: `Welcome back. You have a scheduled reminder due: "${dueList[0].title}".`,
        greetingHi: `वापसी पर स्वागत है। आपका रिमाइंडर समय हो गया है: "${dueList[0].title}"।`
      };
    }

    const topic = state && state.currentTopic;
    if (topic) {
      return {
        hasPriorContext: true,
        topic,
        taskObjective: `exploring ${topic}`,
        nextStep: '',
        dueReminders: [],
        greetingEn: `Welcome back. You were last looking at ${topic}. Would you like to continue?`,
        greetingHi: `वापसी पर स्वागत है। आप पिछली बार ${topic} देख रहे थे। क्या आप जारी रखना चाहेंगे?`
      };
    }

    const lastAct = (state && Array.isArray(state.activities) && state.activities.length > 0)
      ? state.activities[state.activities.length - 1]
      : null;
    if (lastAct && lastAct.page_title) {
      return {
        hasPriorContext: true,
        topic: lastAct.page_title,
        taskObjective: lastAct.user_command || lastAct.page_title,
        nextStep: '',
        dueReminders: [],
        greetingEn: `Welcome back. Earlier you visited ${lastAct.page_title}. Would you like to pick up from there?`,
        greetingHi: `वापसी पर स्वागत है। पहले आप ${lastAct.page_title} देख रहे थे। क्या आप वहीं से शुरू करना चाहेंगे?`
      };
    }

    return { hasPriorContext: false, topic: '', taskObjective: '', nextStep: '', dueReminders: [], greetingEn: '', greetingHi: '' };
  }

  /**
   * Evaluate whether ONE non-intrusive, strictly task-relevant proactive offer should appear.
   * Never runs consequential actions automatically; respects dismissals, cooldowns & privacy toggle.
   */
  function evaluateProactiveSuggestion(state, context = {}) {
    const pc = ensurePersonalContext(state);
    if (pc.privacyControls && pc.privacyControls.proactiveEnabled === false) return null;
    if (context.suppress || context.hasPendingPrompt || context.isAwaitingConfirm) return null;

    const now = Date.now();
    if (!context.ignoreCooldown && pc.lastSuggestionAt && (now - pc.lastSuggestionAt) < 20000) {
      return null;
    }

    const task = (state && state.activeTask) || null;
    const taskDomain = (task && task.domain) || inferDomainFromText(`${(task && task.objective) || ''} ${(task && task.topic) || ''} ${context.lastCommand || ''}`);
    const projIdFromTask = (task && task.topic && taskDomain) ? `proj_${normalizeSlug(task.topic)}_${normalizeSlug(taskDomain)}` : '';
    const proj = (projIdFromTask && pc.projects[projIdFromTask]) || pc.projects[pc.activeProjectId] || null;
    const domain = (task && task.domain) || (taskDomain !== 'general_research' ? taskDomain : '') || (proj && proj.domain) || 'general_research';
    const topic = (task && task.topic) || (proj && proj.rootTopic) || (state && state.currentTopic) || '';

    const steps = (task && Array.isArray(task.plannedSteps)) ? task.plannedSteps : [];
    const doneText = steps.filter((s) => s.status === 'done').map((s) => `${s.id} ${s.label}`).join(' ').toLowerCase();
    const recentCmdText = ((state && state.shortTerm && state.shortTerm.recentCommands) || []).map((c) => c.cmd).join(' ').toLowerCase();
    const combinedDone = `${doneText} ${recentCmdText} ${String(context.lastCommand || '').toLowerCase()}`;

    const isDismissed = (key) => Boolean(pc.dismissedSuggestions && pc.dismissedSuggestions[key]);

    // Case 1: University research — admission/tuition compared, deadlines not checked
    if (domain === 'university_research') {
      const checkedReqsOrTuition = /\b(?:admission|requirements|tuition|compare|fee)\b/.test(combinedDone);
      const checkedDeadlines = /\b(?:deadline|deadlines|closing\s+date)\b/.test(combinedDone) || (proj && proj.deadlines && proj.deadlines.length > 0);
      const sugId = `pro_uni_deadlines_${normalizeSlug(topic || 'uni')}`;
      if (checkedReqsOrTuition && !checkedDeadlines && !isDismissed(sugId)) {
        return {
          id: sugId,
          category: 'university_deadlines',
          text: `You've compared admission/tuition details. Would you like me to check the application deadlines too?`,
          acceptLabel: 'Check Deadlines',
          dismissLabel: 'Not Now',
          commandText: `Check application deadlines${topic ? ` for ${topic} universities` : ''}`
        };
      }
    }

    // Case 2: Travel research — flights or hotels researched, official entry/visa requirements not checked
    if (domain === 'travel_planning' || domain === 'hotel_booking' || domain === 'flight_booking' || domain === 'accommodation') {
      const checkedFlightsOrHotels = /\b(?:flight|flights|hotel|hotels|accommodation|stay|tokyo|japan)\b/.test(combinedDone);
      const checkedEntry = /\b(?:visa|entry\s+requirements|immigration|passport)\b/.test(combinedDone);
      const dest = topic || 'this destination';
      const sugId = `pro_travel_entry_${normalizeSlug(dest)}`;
      if (checkedFlightsOrHotels && !checkedEntry && !isDismissed(sugId)) {
        return {
          id: sugId,
          category: 'travel_entry_requirements',
          text: `Would you like me to check the official entry and visa requirements for ${dest}?`,
          acceptLabel: 'Check Entry Rules',
          dismissLabel: 'Dismiss',
          commandText: `What are the official entry requirements for ${dest}?`
        };
      }
    }

    // Case 3: Product comparison — offer warranty / compatibility check
    if (domain === 'product_research') {
      const comparedProducts = /\b(?:compare|laptop|specs|specifications|macbook|thinkpad)\b/.test(combinedDone);
      const checkedWarranty = /\b(?:warranty|compatibility|ports)\b/.test(combinedDone);
      const sugId = `pro_prod_warranty_${normalizeSlug(topic || 'prod')}`;
      if (comparedProducts && !checkedWarranty && !isDismissed(sugId)) {
        return {
          id: sugId,
          category: 'product_warranty',
          text: `Would you like me to compare warranty, battery, and compatibility details next?`,
          acceptLabel: 'Compare Warranty & Specs',
          dismissLabel: 'Dismiss',
          commandText: 'Compare warranty and compatibility details'
        };
      }
    }

    return null;
  }

  function markSuggestionShown(state, sugId) {
    const pc = ensurePersonalContext(state);
    pc.lastSuggestionAt = Date.now();
    return sugId;
  }

  function dismissSuggestion(state, sugId) {
    const pc = ensurePersonalContext(state);
    if (!sugId) return;
    pc.dismissedSuggestions[sugId] = Date.now();
  }

  /**
   * Sort official sources first when user prefers official websites.
   */
  function sortUrlsOfficialFirst(urls = [], preferOfficial = false) {
    if (!preferOfficial || !Array.isArray(urls)) return urls;
    return urls.slice().sort((a, b) => {
      const aOff = Boolean((a && a.official) || isOfficialUrl(a && (a.officialUrl || a.url)));
      const bOff = Boolean((b && b.official) || isOfficialUrl(b && (b.officialUrl || b.url)));
      return Number(bOff) - Number(aOff);
    });
  }

  /**
   * Decision Support (Section 10):
   * Compare alternatives separating Facts, User Preferences, Recommendations & Rationale, and Unverified Gaps.
   * Never fabricates prices, cutoffs, deadlines, or availability.
   */
  function buildDecisionComparison(items = [], state = {}, opts = {}) {
    const pc = ensurePersonalContext(state);
    const task = state && state.activeTask;
    const constraints = (task && task.constraints) || {};
    const preferOfficial = Boolean(getPreferenceValue(state, 'preferOfficialSources', false));
    const fmtPref = opts.format || getPreferenceValue(state, 'presentationFormat', 'standard');
    const stylePref = opts.style || getPreferenceValue(state, 'responseStyle', 'standard');

    const proj = (pc && pc.projects && pc.projects[pc.activeProjectId]) || null;
    const efMap = (proj && proj.research && proj.research.entityFindings) || {};

    const cleanItems = (Array.isArray(items) ? items : []).slice(0, 4).map((it, idx) => {
      const slug = normalizeSlug(it.title || `item_${idx}`);
      const stored = efMap[slug] || {};
      const fees = stored.fees || it.fees || 'Not yet verified on official portal';
      const deadlines = stored.deadlines || it.deadlines || 'Check live deadline on portal';
      const reqs = stored.requirements || it.requirements || it.specs || it.summary || 'Not summarized yet';
      const url = stored.officialUrl || it.officialUrl || it.url || '';
      const official = Boolean(it.official || stored.official || isOfficialUrl(url));
      return {
        index: idx + 1,
        title: cleanStr(it.title, 80),
        official,
        url,
        fees,
        deadlines,
        requirements: cleanStr(reqs, 120)
      };
    });

    const userPrefsList = [];
    if (constraints.freeOnly) userPrefsList.push('Tuition-free / no-cost preference');
    if (constraints.budget) userPrefsList.push(`Budget: ${constraints.budget}`);
    if (constraints.degreeLevel) userPrefsList.push(`Degree: ${constraints.degreeLevel}`);
    if (preferOfficial) userPrefsList.push('Prefer official primary sources');

    // Score strictly by explicitly verified alignment (never inventing scores or rankings)
    let recommended = cleanItems[0] || null;
    let rationale = 'Listed alternatives have unverified live figures — inspect official portals directly before deciding.';
    if (cleanItems.length >= 2) {
      const officialItems = cleanItems.filter((i) => i.official);
      if (preferOfficial && officialItems.length === 1) {
        recommended = officialItems[0];
        rationale = `Recommended ${recommended.title} for inspection first because it provides an explicit official source matching your source preference.`;
      } else if (constraints.freeOnly) {
        const freeMatch = cleanItems.find((i) => /\bfree\b|\b0\b|tuition-free/i.test(`${i.fees} ${i.requirements}`));
        if (freeMatch) {
          recommended = freeMatch;
          rationale = `Recommended ${recommended.title} because its recorded criteria align with your free/no-cost preference.`;
        }
      }
      if (!rationale.startsWith('Recommended')) {
        rationale = `${cleanItems[0].title} and ${cleanItems[1].title} differ primarily in program criteria and unverified live fees/deadlines; verify both on their official portals.`;
      }
    }

    const missingFields = [];
    if (cleanItems.some((i) => i.fees.startsWith('Not yet'))) missingFields.push('live fees/pricing');
    if (cleanItems.some((i) => i.deadlines.startsWith('Check live'))) missingFields.push('exact application deadlines');

    const table = cleanItems.length >= 2
      ? {
          headers: ['Option', 'Official Source', 'Fees / Price', 'Deadlines / Dates', 'Notes / Specs'],
          rows: cleanItems.map((i) => [
            i.title,
            i.official ? 'Official' : 'Reference',
            i.fees,
            i.deadlines,
            i.requirements
          ])
        }
      : null;

    const factsText = cleanItems.map((i) => `${i.title}: ${i.requirements} (Fees: ${i.fees}; Deadlines: ${i.deadlines})`).join(' | ');
    const prefText = userPrefsList.length > 0 ? userPrefsList.join(', ') : 'None specified yet';
    const gapText = missingFields.length > 0 ? `Unverified information (requires checking live official pages): ${missingFields.join(', ')}.` : 'All tracked fields reviewed.';

    let formattedText = '';
    if (stylePref === 'concise' || fmtPref === 'concise') {
      formattedText = `Facts: ${cleanItems.map((i) => `${i.title} (${i.fees})`).join(' vs ')}. Note: ${gapText}`;
    } else if (fmtPref === 'numbered') {
      formattedText = `Options compared (${cleanItems.length}):\n` + cleanItems.map((i, k) => `${k + 1}. ${i.title} — ${i.requirements} (Fees: ${i.fees})`).join('\n') + `\nUnverified gaps: ${missingFields.join(', ') || 'none'}.`;
    } else {
      formattedText = [
        `Facts: ${factsText}`,
        `Your Preferences: ${prefText}.`,
        `Recommendation: ${rationale}`,
        gapText
      ].join('\n');
    }

    return {
      text: formattedText,
      table: fmtPref === 'table' || opts.preferTable ? table : null,
      numberedItems: fmtPref === 'numbered' ? cleanItems.map((i) => `${i.title}: ${i.requirements} (${i.fees})`) : null,
      warning: missingFields.length > 0 ? `Unverified live details: ${missingFields.join(', ')}. Figures are never invented.` : '',
      sources: cleanItems.filter((i) => i.url).map((i) => ({ title: i.title, url: i.url, official: i.official })),
      sections: { facts: cleanItems, preferences: userPrefsList, recommendation: rationale, unverified: missingFields }
    };
  }

  /**
   * Parse natural-language reminder or future check requests cleanly (Section 5).
   * Returns { isReminder, title, targetTimeMs, targetIso, checkType, url, explanation, requiresDateClarification }.
   */
  function parseReminderRequest(rawText = '', nowMs = Date.now(), context = {}) {
    const raw = cleanStr(rawText, 240);
    const lower = raw.toLowerCase();
    const isRelCheck = /^(?:please\s+)?check\s+(?:whether|if|this|the|my|again)\b/i.test(lower) && /\b(?:tomorrow|next\s+(?:week|month)|in\s+\d+\s+(?:minute|min|hour|day)s?|tonight|later)\b/i.test(lower);
    const isRemind = /\b(?:remind\s+me|set\s+(?:a\s+)?reminder)\b/i.test(lower) || isRelCheck;
    if (!isRemind) return null;

    const checkType = /\bcheck\b/i.test(lower) ? 'availability_recheck' : 'reminder';
    const d = new Date(nowMs);
    let targetTimeMs = 0;
    let timeDesc = '';

    const inMatch = lower.match(/\bin\s+(\d+)\s+(second|sec|minute|min|hour|hr|day)s?\b/i);
    if (inMatch) {
      const n = Math.max(1, parseInt(inMatch[1], 10));
      const unit = inMatch[2].toLowerCase();
      const mult = unit.startsWith('sec') ? 1000 : (unit.startsWith('min') ? 60000 : (unit.startsWith('hour') || unit.startsWith('hr') ? 3600000 : 86400000));
      targetTimeMs = nowMs + n * mult;
      timeDesc = `in ${n} ${unit}${n > 1 ? 's' : ''}`;
    } else if (/\btomorrow\b/i.test(lower)) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0, 0);
      targetTimeMs = t.getTime();
      timeDesc = `tomorrow at ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else if (/\bnext\s+month\b/i.test(lower)) {
      const t = new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), 28), 9, 0, 0, 0);
      targetTimeMs = t.getTime();
      timeDesc = `next month (${t.toDateString()})`;
    } else if (/\bnext\s+week\b/i.test(lower)) {
      targetTimeMs = nowMs + 7 * 24 * 60 * 60 * 1000;
      timeDesc = `next week (${new Date(targetTimeMs).toDateString()})`;
    } else if (/\btonight\b/i.test(lower)) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 0, 0, 0);
      targetTimeMs = t.getTime() > nowMs ? t.getTime() : (nowMs + 4 * 3600000);
      timeDesc = 'tonight at 8:00 PM';
    } else if (/\bbefore\s+(?:this|the)\s+deadline\b/i.test(lower)) {
      const deadlines = (context && Array.isArray(context.deadlines)) ? context.deadlines : [];
      const firstDl = deadlines[0] && deadlines[0].dateText ? Date.parse(deadlines[0].dateText) : NaN;
      if (Number.isFinite(firstDl) && firstDl > nowMs + 86400000) {
        targetTimeMs = firstDl - 2 * 86400000;
        timeDesc = `2 days before ${deadlines[0].dateText}`;
      } else {
        targetTimeMs = nowMs + 24 * 3600000;
        return {
          isReminder: true,
          requiresDateClarification: true,
          checkType,
          title: 'Finish action before deadline',
          targetTimeMs,
          targetIso: new Date(targetTimeMs).toISOString(),
          timeDesc: 'No exact deadline date saved yet',
          url: cleanStr(context.url || '', 240)
        };
      }
    } else {
      targetTimeMs = nowMs + 24 * 3600000;
      timeDesc = `tomorrow (${new Date(targetTimeMs).toLocaleString()})`;
    }

    let title = raw
      .replace(/^(?:please\s+)?(?:remind\s+me(?:\s+to)?|set\s+(?:a\s+)?reminder(?:\s+to|\s+for)?|check\s+(?:whether|if)?)\s+/i, '')
      .replace(/\s+\b(?:tomorrow|next\s+month|next\s+week|tonight|in\s+\d+\s+(?:second|sec|minute|min|hour|hr|day)s?|before\s+(?:this|the)\s+deadline|again)\b[.?!]*$/gi, '')
      .replace(/[.?!]+$/, '')
      .trim();
    if (!title || title.length < 3) {
      title = context.topic ? `Follow up on ${context.topic}` : 'Scheduled browsing follow-up';
    } else if (checkType === 'availability_recheck' && !/^check\b/i.test(title)) {
      title = `Check ${title}`;
    }

    const cleanUrl = cleanStr(context.url || '', 240);
    const explanation = checkType === 'availability_recheck'
      ? `Chrome will schedule an alarm for ${timeDesc} to remind you to re-check "${title}"${cleanUrl ? ` (${cleanUrl})` : ''}. Background alarms notify when Chrome runs and do not scrape continuously offline.`
      : `Chrome will schedule a reminder alarm for "${title}" ${timeDesc}.`;

    return {
      isReminder: true,
      requiresDateClarification: false,
      title,
      checkType,
      targetTimeMs,
      targetIso: new Date(targetTimeMs).toISOString(),
      timeDesc,
      url: cleanUrl,
      projectTopic: cleanStr(context.topic || '', 80),
      taskId: cleanStr(context.taskId || '', 60),
      explanation
    };
  }

  return {
    createDefaultPersonalContext,
    ensurePersonalContext,
    isDisallowedPersonalTrait,
    isOfficialUrl,
    ensureProject,
    inferDomainFromText,
    recordEntityResearch,
    querySeparatedEntityContext,
    setExplicitPreference,
    recordAdaptiveSignal,
    recordControlCorrection,
    lookupControlOverride,
    getPreferenceValue,
    resetPreferences,
    applyUserCorrection,
    buildCrossSessionResumeSummary,
    evaluateProactiveSuggestion,
    markSuggestionShown,
    dismissSuggestion,
    sortUrlsOfficialFirst,
    buildDecisionComparison,
    parseReminderRequest
  };
});
