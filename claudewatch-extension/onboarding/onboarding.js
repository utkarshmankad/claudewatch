// Onboarding page: wire up interactive elements.

document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ type: 'ANALYTICS_ACTIVE_DAY', surface: 'onboarding' }, () => void chrome.runtime.lastError);
  // Copy-to-clipboard buttons
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '⧉';
          btn.classList.remove('copied');
        }, 1800);
      });
    });
  });

  // Settings links — open the extension options page
  ['open-settings', 'open-settings-2'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  });

  // Close tab button
  document.getElementById('btn-close')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ANALYTICS_ONBOARDING_DONE' }, () => void chrome.runtime.lastError);
    window.close();
  });
});
