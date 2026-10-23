/* Phone navigation for the step-by-step tools (video and PDF share the same page shape):
   the step's "back" moves up into the progress strip as a plain "‹ 上一步" link, and the bottom bar only
   shows when it holds a real action. Works off the markup alone — .stepper .m-step, section.panel,
   .panel-foot .btn.back — and simply clicks the tool's own back button, so neither tool's logic changes.
   Without this script (e.g. the PDF tool's offline copy) the pages keep their normal bottom bar. */
(() => {
  'use strict';
  const stepper = document.querySelector('.stepper');
  const mStep = stepper && stepper.querySelector('.m-step');
  if (!stepper || !mStep) return;

  const css = document.createElement('style');
  css.textContent = `
    .m-head { display: none; }
    @media (max-width: 640px) {
      .m-nav .m-head { display: flex; align-items: center; gap: 6px; min-height: 30px; margin-bottom: 6px; }
      .m-nav .m-head .m-step { margin: 0; }
      /* .stepper .m-back beats the tools' own ".stepper button" rules */
      .stepper .m-back { flex: none; width: auto; display: inline-flex; align-items: center; gap: 2px; margin-left: -6px; padding: 4px 8px 4px 2px; border: 0; border-radius: 8px;
        background: none; color: var(--accent-strong); font: inherit; font-size: .9rem; font-weight: 600; white-space: nowrap; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      .stepper .m-back::before { content: none; display: none; }
      .stepper .m-back:active { background: var(--accent-soft); }
      .stepper .m-back:disabled { color: var(--muted); opacity: .5; }
      .stepper .m-back[hidden] { display: none; }
      .stepper .m-back svg { width: 18px; height: 18px; }
      .m-head .m-step { flex: 1 1 auto; min-width: 0; }
      .m-back:not([hidden]) + .m-step { padding-left: 10px; border-left: 1px solid var(--line); }
      .m-nav .panel-foot .btn.back { display: none !important; }
      .m-nav .panel-foot.foot-empty { display: none !important; }
    }`;
  document.head.append(css);
  document.documentElement.classList.add('m-nav');

  const head = document.createElement('div');
  head.className = 'm-head';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'm-back';
  back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span>上一步</span>';
  mStep.replaceWith(head);
  head.append(back, mStep);

  const visiblePanel = () => [...document.querySelectorAll('section.panel')].find((p) => !p.hidden);
  const own = (panel) => panel && panel.querySelector('.panel-foot .btn.back');
  back.addEventListener('click', () => { const b = own(visiblePanel()); if (b && !b.disabled) b.click(); });

  let queued = false;
  function sync() {
    queued = false;
    const panel = visiblePanel();
    const b = own(panel);
    back.hidden = !b || b.hidden;
    if (b) {
      back.disabled = b.disabled;
      back.querySelector('span').textContent = (b.querySelector('.lbl') && b.querySelector('.lbl').textContent.trim()) || '上一步';
    }
    // a bottom bar holding only "back" (and the note, hidden on phones) has nothing left to show
    for (const foot of document.querySelectorAll('.panel-foot')) {
      const real = [...foot.querySelectorAll('button, a.btn')]
        .some((x) => !x.classList.contains('back') && !x.hidden && getComputedStyle(x).display !== 'none');
      foot.classList.toggle('foot-empty', !real);
    }
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(sync); } };
  new MutationObserver(queue).observe(document.querySelector('main') || document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class'] });
  window.addEventListener('resize', queue);
  sync();
})();
