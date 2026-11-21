/**
 * Sleepwalker Rebuilt Browser Engine — Visual Fallback Module
 *
 * Implements:
 * - Visual target location when DOM accessible names are insufficient.
 * - Icon / Canvas / SVG cluster identification.
 * - Guard rails: strictly fallback only (never default strategy).
 */
(function (global) {
  'use strict';

  class VisualFallback {
    constructor(options = {}) {
      this.options = Object.assign({
        minConfidence: 0.70
      }, options);
    }

    /**
     * Find interactive visual candidates based on layout clusters and geometry.
     * @param {Element|Document} root
     * @returns {Array<Object>}
     */
    findVisualCandidates(root = document) {
      const candidates = [];
      const interactiveTags = ['svg', 'canvas', 'img', 'i', 'span'];

      const elements = root.querySelectorAll(interactiveTags.join(', '));
      elements.forEach((el) => {
        // Must have pointer cursor or interactive parent
        const style = window.getComputedStyle(el);
        const isClickable = style.cursor === 'pointer' || el.closest('button, a, [onclick], [role="button"]');
        if (!isClickable) return;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 4 || rect.height <= 4) return;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;

        candidates.push({
          element: el,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          tag: el.tagName,
          isCanvas: el.tagName === 'CANVAS',
          isSvg: el.tagName === 'SVG' || Boolean(el.closest('svg'))
        });
      });

      return candidates;
    }

    /**
     * Validate coordinate hit-test before dispatching visual click.
     * @param {number} x
     * @param {number} y
     * @returns {{ ok: boolean, target?: Element, reason?: string }}
     */
    validateCoordinateTarget(x, y) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return { ok: false, reason: 'coordinates_out_of_viewport' };
      }

      const hit = document.elementFromPoint(x, y);
      if (!hit) {
        return { ok: false, reason: 'no_element_at_point' };
      }

      return { ok: true, target: hit };
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VisualFallback };
  } else {
    global.VisualFallback = VisualFallback;
  }
})(typeof window !== 'undefined' ? window : globalThis);
