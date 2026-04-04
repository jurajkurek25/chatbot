/* NeuraDeskApp WP Plugin – Admin JS */
(function ($) {
  'use strict';

  const { ajax_url, nonce, api_base, token, widget_id, site_name } = window.NeuraDesk || {};

  /* ── Helpers ──────────────────────────────────────────────── */
  function setLoading($btn, loading) {
    $btn.find('.nd-btn-text').toggle(!loading);
    $btn.find('.nd-spinner').toggle(loading);
    $btn.prop('disabled', loading);
  }

  function showError($el, msg) {
    $el.text(msg).show();
  }

  function ajax(action, data) {
    return $.post(ajax_url, { action, nonce, ...data });
  }

  /* ── Login ────────────────────────────────────────────────── */
  $(document).on('click', '#nd-btn-login', function () {
    const $btn   = $(this);
    const $err   = $('#nd-login-error').hide();
    const apiBase = $('#nd-api-base').val().trim().replace(/\/$/, '');
    const email   = $('#nd-email').val().trim();
    const password = $('#nd-password').val();

    if (!email || !password) {
      showError($err, 'Prosím vyplňte email a heslo.');
      return;
    }

    setLoading($btn, true);

    ajax('neuradesk_login', { api_base: apiBase, email, password })
      .done(function (res) {
        if (res.success) {
          location.reload();
        } else {
          showError($err, res.data?.message || 'Prihlásenie zlyhalo.');
          setLoading($btn, false);
        }
      })
      .fail(function () {
        showError($err, 'Chyba siete. Skontrolujte URL a skúste znova.');
        setLoading($btn, false);
      });
  });

  // Allow Enter key in password field
  $(document).on('keydown', '#nd-password', function (e) {
    if (e.key === 'Enter') $('#nd-btn-login').trigger('click');
  });

  /* ── Select/Create Widget ─────────────────────────────────── */
  $(document).on('click', '#nd-btn-set-widget', function () {
    const $btn      = $(this);
    const $err      = $('#nd-widget-error').hide();
    const widgetVal = $('#nd-widget-select').val();

    setLoading($btn, true);

    ajax('neuradesk_set_widget', { widget_id: widgetVal, site_name })
      .done(function (res) {
        if (res.success) {
          location.reload();
        } else {
          showError($err, res.data?.message || 'Chyba.');
          setLoading($btn, false);
        }
      })
      .fail(function () {
        showError($err, 'Chyba siete.');
        setLoading($btn, false);
      });
  });

  /* ── Disconnect ───────────────────────────────────────────── */
  $(document).on('click', '.nd-btn-disconnect', function () {
    if (!confirm('Naozaj sa chcete odhlásiť? Widget zostane na webe, ale skenovanie bude treba zopakovať.')) return;
    ajax('neuradesk_disconnect').done(function () { location.reload(); });
  });

  /* ── Embed toggle ─────────────────────────────────────────── */
  $(document).on('change', '#nd-embed-toggle', function () {
    const enabled = $(this).is(':checked') ? 1 : 0;
    ajax('neuradesk_save_settings', { embed_enabled: enabled });
    $('.nd-status-dot').toggleClass('nd-dot-green', !!enabled).toggleClass('nd-dot-gray', !enabled);
    $('.nd-status-row span').html('Chatbot je ' + (enabled ? '<strong>aktívny</strong> na webe' : '<strong>vypnutý</strong>'));
  });

  /* ── Re-scan ──────────────────────────────────────────────── */
  $(document).on('click', '#nd-btn-rescan', function () {
    if (!confirm('Skenovanie pridá obsah znova do znalostnej bázy. Pokračovať?')) return;
    ajax('neuradesk_disconnect_scan').done(function () { location.reload(); });
    // simple: just clear scan_done via a dedicated action OR reload and user triggers scan
    // We trigger via reload + resetting option
    $.post(ajax_url, { action: 'neuradesk_reset_scan', nonce })
      .done(function () { location.reload(); });
  });

  /* ── Copy embed code ─────────────────────────────────────── */
  $(document).on('click', '#nd-btn-copy-embed', function () {
    const code = $('#nd-embed-code').text();
    navigator.clipboard?.writeText(code).then(() => {
      $(this).text('✅ Skopírované!');
      setTimeout(() => $(this).text('📋 Kopírovať'), 2000);
    });
  });

  /* ── Scanner ──────────────────────────────────────────────── */
  let scanTotals   = { pages: 0, posts: 0, products: 0 };
  let scanImported = { pages: 0, posts: 0, products: 0 };
  const hasWoo = window.NeuraDesk?.has_woo || $('#step-products').length > 0;

  $(document).on('click', '#nd-btn-scan', function () {
    $('#nd-scan-box').hide();
    $('#nd-scan-progress').show();
    runScan();
  });

  async function runScan() {
    const types = ['pages', 'posts'];
    if (hasWoo) types.push('products');

    const totalTypes = types.length;
    let typesDone    = 0;

    for (const type of types) {
      setStepStatus(type, 'running');
      setSubLabel(type, 'Skenujem...');

      let offset  = 0;
      let hasMore = true;
      let imported = 0;

      while (hasMore) {
        try {
          const res = await ajaxAsync('neuradesk_scan_batch', { type, offset });

          if (!res.success) {
            setStepStatus(type, 'error');
            setSubLabel(type, res.data?.message || 'Chyba');
            hasMore = false;
            break;
          }

          imported += res.data.imported || 0;
          hasMore   = res.data.has_more || false;
          offset   += 10;

          setSubLabel(type, `Importovaných: ${imported}...`);
        } catch (e) {
          setStepStatus(type, 'error');
          setSubLabel(type, 'Chyba siete');
          hasMore = false;
        }
      }

      scanImported[type] = imported;
      setStepStatus(type, 'done');
      setSubLabel(type, `Hotovo – ${imported} položiek`);

      typesDone++;
      const pct = Math.round((typesDone / totalTypes) * 100);
      $('#nd-progress-bar').css('width', pct + '%');
      $('#nd-progress-label').text(`${typesDone} / ${totalTypes} krokov dokončených`);
    }

    // Mark scan done on server
    await ajaxAsync('neuradesk_mark_scan_done', {});

    // Show overlay
    setTimeout(() => {
      $('#nd-scan-done-overlay').fadeIn(300);
    }, 600);
  }

  function setStepStatus(type, status) {
    const $s = $(`#step-${type}-status`);
    const $r = $(`#step-${type}`);
    $r.removeClass('nd-step-running nd-step-done nd-step-error');
    $s.text('');

    if (status === 'running') {
      $r.addClass('nd-step-running');
      $s.html('<div class="nd-spinner nd-spinner-inline"></div>');
    } else if (status === 'done') {
      $r.addClass('nd-step-done');
      $s.text('✅');
    } else if (status === 'error') {
      $r.addClass('nd-step-error');
      $s.text('❌');
    }
  }

  function setSubLabel(type, text) {
    $(`#step-${type}-sub`).text(text);
  }

  function ajaxAsync(action, data) {
    return new Promise((resolve, reject) => {
      $.post(ajax_url, { action, nonce, ...data })
        .done(resolve)
        .fail(reject);
    });
  }

  // Close overlay on background click
  $(document).on('click', '#nd-scan-done-overlay', function (e) {
    if (e.target === this) location.reload();
  });

})(jQuery);
