<?php defined( 'ABSPATH' ) || exit;

$token     = get_option( 'neuradesk_token', '' );
$widget_id = get_option( 'neuradesk_widget_id', '' );
$user_name = get_option( 'neuradesk_user_name', '' );
$api_base  = get_option( 'neuradesk_api_base', 'https://neuradesk.online' );
$scan_done = get_option( 'neuradesk_scan_done', 0 );
$embed_on  = get_option( 'neuradesk_embed_enabled', 0 );

$scanner      = new NeuraDeskScanner();
$count_pages  = $scanner->count_pages();
$count_posts  = $scanner->count_posts();
$count_prods  = $scanner->count_products();
$has_woo      = class_exists( 'WooCommerce' );
?>

<div class="wrap nd-wrap">
  <div class="nd-header">
    <div class="nd-logo">
      <svg viewBox="0 0 24 24" width="32" height="32"><path fill="#2563eb" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
      <span>NeuraDeskApp</span>
    </div>
    <div class="nd-version">v<?php echo NEURADESK_VERSION; ?></div>
  </div>

  <?php if ( ! $token ) : ?>
  <!-- ── STEP 1: Login ──────────────────────────────────────── -->
  <div class="nd-card" id="nd-step-login">
    <h2>Prihlásenie do NeuraDeskApp</h2>
    <p class="nd-subtitle">Prihláste sa vaším účtom na <a href="https://neuradesk.online" target="_blank">neuradesk.online</a>. Plugin automaticky naskenuje váš web a nasadí chatbot.</p>

    <div class="nd-form-group">
      <label>NeuraDeskApp URL</label>
      <input type="url" id="nd-api-base" value="https://neuradesk.online" class="nd-input">
      <span class="nd-hint">Zmeňte iba ak používate self-hosted verziu.</span>
    </div>
    <div class="nd-form-group">
      <label>Email</label>
      <input type="email" id="nd-email" class="nd-input" placeholder="vas@email.sk" autocomplete="email">
    </div>
    <div class="nd-form-group">
      <label>Heslo</label>
      <input type="password" id="nd-password" class="nd-input" placeholder="••••••••" autocomplete="current-password">
    </div>

    <div id="nd-login-error" class="nd-error" style="display:none"></div>

    <button class="nd-btn nd-btn-primary" id="nd-btn-login">
      <span class="nd-btn-text">Prihlásiť sa</span>
      <span class="nd-spinner" style="display:none"></span>
    </button>

    <p class="nd-signup-hint">Nemáte účet? <a href="https://neuradesk.online" target="_blank">Zaregistrujte sa zadarmo →</a></p>
  </div>

  <?php elseif ( ! $widget_id ) : ?>
  <!-- ── STEP 2: Select / create widget ────────────────────── -->
  <div class="nd-card" id="nd-step-widget">
    <div class="nd-user-badge">
      <div class="nd-user-icon">👤</div>
      <div>
        <strong><?php echo esc_html( $user_name ); ?></strong>
        <span><?php echo esc_html( $api_base ); ?></span>
      </div>
      <button class="nd-btn-link nd-btn-disconnect" id="nd-btn-disconnect">Odhlásiť</button>
    </div>

    <h2>Vybrať alebo vytvoriť widget</h2>
    <p class="nd-subtitle">Vyberte existujúci widget z vášho účtu, alebo vytvorte nový pre tento WordPress web.</p>

    <div class="nd-form-group">
      <label>Widget</label>
      <select id="nd-widget-select" class="nd-input">
        <option value="__new__">➕ Vytvoriť nový widget pre "<?php echo esc_html( get_bloginfo('name') ); ?>"</option>
        <?php
        $api     = new NeuraDeskAPI( $api_base, $token );
        $widgets = $api->get_widgets();
        if ( ! is_wp_error( $widgets ) && is_array( $widgets ) ) {
            foreach ( $widgets as $w ) {
                echo '<option value="' . esc_attr( $w['id'] ) . '">' . esc_html( $w['name'] ) . '</option>';
            }
        }
        ?>
      </select>
    </div>

    <div id="nd-widget-error" class="nd-error" style="display:none"></div>

    <button class="nd-btn nd-btn-primary" id="nd-btn-set-widget">
      <span class="nd-btn-text">Pokračovať →</span>
      <span class="nd-spinner" style="display:none"></span>
    </button>
  </div>

  <?php else : ?>
  <!-- ── STEP 3: Scan + status ──────────────────────────────── -->
  <div class="nd-grid">

    <!-- Left: Status + Controls -->
    <div class="nd-card">
      <div class="nd-user-badge">
        <div class="nd-user-icon">👤</div>
        <div>
          <strong><?php echo esc_html( $user_name ); ?></strong>
          <span><?php echo esc_html( $api_base ); ?></span>
        </div>
        <button class="nd-btn-link nd-btn-disconnect" id="nd-btn-disconnect">Odhlásiť</button>
      </div>

      <div class="nd-status-row">
        <div class="nd-status-dot <?php echo $embed_on ? 'nd-dot-green' : 'nd-dot-gray'; ?>"></div>
        <span>Chatbot je <?php echo $embed_on ? '<strong>aktívny</strong> na webe' : '<strong>vypnutý</strong>'; ?></span>
        <label class="nd-toggle" title="Zapnúť/vypnúť embed na webe">
          <input type="checkbox" id="nd-embed-toggle" <?php checked( $embed_on ); ?>>
          <span class="nd-toggle-slider"></span>
        </label>
      </div>

      <div class="nd-widget-info">
        <div class="nd-info-label">Widget ID</div>
        <div class="nd-info-value nd-mono"><?php echo esc_html( $widget_id ); ?></div>
        <a href="<?php echo esc_url( $api_base . '/dashboard' ); ?>" target="_blank" class="nd-btn-link">Otvoriť dashboard →</a>
      </div>

      <?php if ( ! $scan_done ) : ?>
      <div class="nd-scan-box" id="nd-scan-box">
        <h3>Skenovanie obsahu webu</h3>
        <p>Plugin naskenuje váš web a automaticky naplní znalostnou bázou chatbota.</p>

        <div class="nd-count-row">
          <div class="nd-count-item">
            <span class="nd-count-num"><?php echo $count_pages; ?></span>
            <span class="nd-count-label">Stránok</span>
          </div>
          <div class="nd-count-item">
            <span class="nd-count-num"><?php echo $count_posts; ?></span>
            <span class="nd-count-label">Príspevkov</span>
          </div>
          <?php if ( $has_woo ) : ?>
          <div class="nd-count-item">
            <span class="nd-count-num"><?php echo $count_prods; ?></span>
            <span class="nd-count-label">Produktov</span>
          </div>
          <?php endif; ?>
        </div>

        <?php if ( ! $has_woo ) : ?>
        <div class="nd-notice nd-notice-info">WooCommerce nie je aktívny – skenujú sa iba stránky a príspevky.</div>
        <?php endif; ?>

        <button class="nd-btn nd-btn-primary nd-btn-full" id="nd-btn-scan">
          <span class="nd-btn-text">🔍 Spustiť skenovanie</span>
          <span class="nd-spinner" style="display:none"></span>
        </button>
      </div>

      <!-- Progress (hidden until scan starts) -->
      <div id="nd-scan-progress" style="display:none">
        <h3>Skenuje sa...</h3>
        <div class="nd-steps">
          <div class="nd-step" id="step-pages">
            <div class="nd-step-icon">📄</div>
            <div class="nd-step-body">
              <div class="nd-step-label">Stránky</div>
              <div class="nd-step-sub" id="step-pages-sub">čaká...</div>
            </div>
            <div class="nd-step-status" id="step-pages-status"></div>
          </div>
          <div class="nd-step" id="step-posts">
            <div class="nd-step-icon">📝</div>
            <div class="nd-step-body">
              <div class="nd-step-label">Príspevky (blog)</div>
              <div class="nd-step-sub" id="step-posts-sub">čaká...</div>
            </div>
            <div class="nd-step-status" id="step-posts-status"></div>
          </div>
          <?php if ( $has_woo ) : ?>
          <div class="nd-step" id="step-products">
            <div class="nd-step-icon">🛍️</div>
            <div class="nd-step-body">
              <div class="nd-step-label">WooCommerce produkty</div>
              <div class="nd-step-sub" id="step-products-sub">čaká...</div>
            </div>
            <div class="nd-step-status" id="step-products-status"></div>
          </div>
          <?php endif; ?>
        </div>
        <div class="nd-progress-bar-wrap">
          <div class="nd-progress-bar" id="nd-progress-bar" style="width:0%"></div>
        </div>
        <div class="nd-progress-label" id="nd-progress-label">Pripravujem...</div>
      </div>

      <?php else : ?>
      <!-- Scan already done -->
      <div class="nd-success-box">
        <div class="nd-success-icon">✅</div>
        <div>
          <strong>Skenovanie dokončené</strong>
          <p>Znalostná báza chatbota je naplnená obsahom vášho webu.</p>
        </div>
        <button class="nd-btn nd-btn-secondary nd-btn-sm" id="nd-btn-rescan">Skenovať znova</button>
      </div>
      <?php endif; ?>
    </div>

    <!-- Right: Embed code -->
    <div class="nd-card nd-card-secondary">
      <h3>Embed kód (manuálne)</h3>
      <p class="nd-subtitle">Plugin vkladá kód automaticky. Pre manuálne použitie:</p>
      <div class="nd-code-block">
        <code id="nd-embed-code">&lt;script&gt;window.NeuraDeskConfig={widgetId:"<?php echo esc_js( $widget_id ); ?>"};&lt;/script&gt;
&lt;script src="<?php echo esc_url( $api_base ); ?>/widget.js" async&gt;&lt;/script&gt;</code>
      </div>
      <button class="nd-btn nd-btn-secondary nd-btn-sm" id="nd-btn-copy-embed">📋 Kopírovať</button>

      <div style="margin-top:1.5rem">
        <h3>Čo bol naskenovaný</h3>
        <ul class="nd-feature-list">
          <li>✅ Všetky publikované <strong>stránky</strong> (<?php echo $count_pages; ?>)</li>
          <li>✅ Najnovšie <strong>príspevky</strong> (<?php echo $count_posts; ?>)</li>
          <?php if ( $has_woo ) : ?>
          <li>✅ <strong>WooCommerce produkty</strong> (<?php echo $count_prods; ?>) – aj ako produktové karty</li>
          <?php else : ?>
          <li>⚪ WooCommerce nie je aktívny</li>
          <?php endif; ?>
        </ul>
      </div>

      <div style="margin-top:1.5rem">
        <h3>Ďalšie kroky</h3>
        <ul class="nd-feature-list">
          <li>🎨 <a href="<?php echo esc_url( $api_base . '/dashboard' ); ?>" target="_blank">Prispôsobiť vzhľad chatbota →</a></li>
          <li>💬 Pridať vlastné otázky a CTA</li>
          <li>📊 Sledovať kontakty zo chatu</li>
        </ul>
      </div>
    </div>
  </div>

  <?php endif; ?>

  <div id="nd-scan-done-overlay" style="display:none">
    <div class="nd-scan-done-card">
      <div style="font-size:3rem;margin-bottom:0.5rem">🎉</div>
      <h2>Chatbot je pripravený!</h2>
      <p>Znalostná báza je naplnená. Chatbot sa zobrazuje na vašom webe.</p>
      <a href="<?php echo esc_url( get_home_url() ); ?>" target="_blank" class="nd-btn nd-btn-primary">Pozrieť web →</a>
      <a href="<?php echo esc_url( $api_base . '/dashboard' ); ?>" target="_blank" class="nd-btn nd-btn-secondary">NeuraDeskApp dashboard →</a>
    </div>
  </div>

</div>
