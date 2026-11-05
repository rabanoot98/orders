// Independent of sign-in and Supabase: the invitation is ready on entry.
(() => {
  const banner = document.getElementById('pwaBanner');
  const installButton = document.getElementById('pwaInstall');
  const menuButton = document.getElementById('pwaMenuInstall');
  const help = document.getElementById('pwaHelp');
  const standalone = window.matchMedia('(display-mode: standalone)');
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid;
  const dismissalKey = 'orders98-install-dismissed-at';
  const week = 7 * 24 * 60 * 60 * 1000;
  let deferredPrompt = null;
  let installed = false;
  let dismissedThisVisit = false;
  let prompting = false;

  const isInstalled = () => installed || standalone.matches || navigator.standalone === true;

  function recentlyDismissed() {
    if (dismissedThisVisit) return true;
    try {
      const at = Number(localStorage.getItem(dismissalKey));
      return at > 0 && Date.now() - at < week;
    } catch {
      return false; // Storage may be unavailable in private browsing.
    }
  }

  function render() {
    const available = window.isSecureContext && !isInstalled() && isMobile;
    banner.hidden = !available || recentlyDismissed();
    menuButton.hidden = !available;
    installButton.textContent = deferredPrompt ? 'התקנה' : 'התקנה בנייד';
    installButton.disabled = prompting;
    menuButton.disabled = prompting;
  }

  function dismiss() {
    dismissedThisVisit = true;
    try { localStorage.setItem(dismissalKey, String(Date.now())); } catch { /* Keep this visit usable. */ }
    render();
  }

  function showHelp() {
    document.getElementById('accountMenu')?.classList.remove('open');
    const embedded = /; wv\)|\bwv\b|FBAN|FBAV|Instagram|Line\//i.test(ua)
      || (isIOS && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua));
    let intro;
    let steps;
    if (isIOS) {
      intro = 'הוסיפו את מערכת ההזמנות למסך הבית באייפון או באייפד:';
      steps = [
        'פתחו את הקישור של המערכת בדפדפן Safari.',
        'לחצו על כפתור השיתוף ובחרו ״הוסף למסך הבית״.',
        'אם מופיעה האפשרות ״פתח כיישום אינטרנט״, השאירו אותה פעילה ולחצו ״הוסף״.',
      ];
    } else if (embedded) {
      intro = 'כדי להתקין, צריך לפתוח את המערכת בדפדפן הרגיל של הנייד:';
      steps = [
        'בתפריט של האפליקציה בחרו ״פתיחה בדפדפן״, או העתיקו את הקישור ופתחו אותו ב־Chrome.',
        'לחצו שוב על ״התקנה״, או בחרו בתפריט הדפדפן ״התקנת אפליקציה״ / ״הוספה למסך הבית״.',
        'אשרו את ההתקנה.',
      ];
    } else {
      intro = 'אם חלון ההתקנה לא נפתח, אפשר להתקין דרך תפריט הדפדפן:';
      steps = [
        'פתחו את תפריט הדפדפן (⋮). להתקנה בנייד מומלץ להשתמש ב־Chrome.',
        'בחרו ״התקנת אפליקציה״ או ״הוספה למסך הבית״, אם האפשרות מופיעה.',
        'אשרו את ההתקנה. אם האפשרות חסרה, בדקו אם המערכת כבר מותקנת במסך הבית.',
      ];
    }
    document.getElementById('pwaHelpIntro').textContent = intro;
    document.getElementById('pwaHelpSteps').replaceChildren(...steps.map(text => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
    if (!help.open) help.showModal();
  }

  async function install() {
    if (prompting) return;
    if (!deferredPrompt) { showHelp(); return; }
    const prompt = deferredPrompt;
    deferredPrompt = null; // Each browser event can only be used once.
    prompting = true;
    render();
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') {
        installed = true;
        help.close();
      } else {
        dismiss();
      }
    } catch {
      showHelp();
    } finally {
      prompting = false;
      render();
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    if (!isMobile) return;
    event.preventDefault();
    deferredPrompt = event;
    render();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    help.close();
    render();
  });
  const onDisplayChange = () => { if (isInstalled()) help.close(); render(); };
  if (standalone.addEventListener) standalone.addEventListener('change', onDisplayChange);
  else standalone.addListener(onDisplayChange);
  window.addEventListener('pageshow', render);
  window.addEventListener('storage', event => { if (event.key === dismissalKey) render(); });
  installButton.addEventListener('click', install);
  menuButton.addEventListener('click', install);
  document.getElementById('pwaDismiss').addEventListener('click', dismiss);
  document.getElementById('pwaHelpClose').addEventListener('click', () => help.close());
  document.getElementById('pwaHelpDone').addEventListener('click', () => help.close());
  render();

  // Network only: no app shell, inventory, orders or API responses are cached.
  // Opening/reloading the installed app requests the current files from the server.
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then(registration => registration.update())
      .catch(error => console.warn('PWA registration:', error));
  }
})();
