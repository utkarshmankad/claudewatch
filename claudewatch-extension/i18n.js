// Token Watcher i18n helper for extension pages.
// English text stays in the HTML as the fallback; data-i18n swaps it for the
// active locale's message when chrome.i18n is available.
(function (root) {
  'use strict';

  function getMessage(key, subs) {
    try {
      const msg = root.chrome && root.chrome.i18n && root.chrome.i18n.getMessage(key, subs);
      return msg || '';
    } catch {
      return '';
    }
  }

  function t(key, subs, fallback) {
    return getMessage(key, subs) || fallback || key;
  }

  function uiLocale() {
    try {
      const lang = root.chrome && root.chrome.i18n && root.chrome.i18n.getUILanguage();
      return lang || 'en';
    } catch {
      return 'en';
    }
  }

  // en-XA is the pseudo-locale; Intl cannot format it, so use English rules.
  function formatLocale() {
    const loc = uiLocale().replace(/_/g, '-');
    return /^en-XA$/i.test(loc) ? 'en' : loc;
  }

  function toDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDateTime(value, options, locale) {
    const d = toDate(value);
    if (!d) return '';
    return new Intl.DateTimeFormat(locale || formatLocale(), options || { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }

  function formatTime(value, locale) {
    return formatDateTime(value, { timeStyle: 'short' }, locale);
  }

  function formatDate(value, locale) {
    return formatDateTime(value, { dateStyle: 'medium' }, locale);
  }

  function formatNumber(value, options, locale) {
    return new Intl.NumberFormat(locale || formatLocale(), options).format(value);
  }

  function apply(doc) {
    const d = doc || root.document;
    if (!d) return;
    d.querySelectorAll('[data-i18n]').forEach((el) => {
      const msg = getMessage(el.getAttribute('data-i18n'));
      if (msg) el.textContent = msg;
    });
    // data-i18n-attr="title:key;aria-label:key2"
    d.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        const msg = attr && key ? getMessage(key) : '';
        if (msg) el.setAttribute(attr, msg);
      });
    });
    const titleKey = d.documentElement && d.documentElement.getAttribute('data-i18n-title');
    const title = titleKey ? getMessage(titleKey) : '';
    if (title) d.title = title;
    const lang = uiLocale();
    if (d.documentElement) {
      d.documentElement.lang = lang.replace(/_/g, '-');
    }
  }

  const api = { t, apply, uiLocale, formatLocale, formatDateTime, formatTime, formatDate, formatNumber };
  root.TokenWatcherI18n = api;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => apply());
    else apply();
  }
})(typeof self !== 'undefined' ? self : globalThis);
