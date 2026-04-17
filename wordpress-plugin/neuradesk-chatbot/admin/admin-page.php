<?php defined( 'ABSPATH' ) || exit;

$token     = get_option( 'neuradesk_token', '' );
$widget_id = get_option( 'neuradesk_widget_id', '' );
$user_name = get_option( 'neuradesk_user_name', '' );
$api_base  = get_option( 'neuradesk_api_base', 'https://neuradesk.com' );
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
    <h2><?php echo esc_html( nd_t( 'login_title' ) ); ?></h2>
    <p class="nd-subtitle"><?php echo esc_html( nd_t( 'login_subtitle' ) ); ?> <a href="https://neuradesk.com" target="_blank"><?php echo esc_html( nd_t( 'login_subtitle_link' ) ); ?></a>.</p>

    <div class="nd-form-group">
      <label><?php echo esc_html( nd_t( 'label_api_url' ) ); ?></label>
      <input type="url" id="nd-api-base" value="https://neuradesk.com" class="nd-input">
      <span class="nd-hint"><?php echo esc_html( nd_t( 'hint_self_hosted' ) ); ?></span>
    </div>
    <div class="nd-form-group">
      <label><?php echo esc_html( nd_t( 'label_email' ) ); ?></label>
      <input type="email" id="nd-email" class="nd-input" placeholder="vas@email.sk" autocomplete="email">
    </div>
    <div class="nd-form-group">
      <label><?php echo esc_html( nd_t( 'label_password' ) ); ?></label>
      <input type="password" id="nd-password" class="nd-input" placeholder="••••••••" autocomplete="current-password">
    </div>

    <div id="nd-login-error" class="nd-error" style="display:none"></div>

    <button class="nd-btn nd-btn-primary" id="nd-btn-login">
      <span class="nd-btn-text"><?php echo esc_html( nd_t( 'btn_login' ) ); ?></span>
      <span class="nd-spinner" style="display:none"></span>
    </button>

    <p class="nd-signup-hint"><?php echo esc_html( nd_t( 'no_account' ) ); ?> <a href="https://neuradesk.com" target="_blank"><?php echo esc_html( nd_t( 'register_free' ) ); ?></a></p>
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
      <button class="nd-btn-link nd-btn-disconnect" id="nd-btn-disconnect"><?php echo esc_html( nd_t( 'btn_logout' ) ); ?></button>
    </div>

    <h2><?php echo esc_html( nd_t( 'widget_title' ) ); ?></h2>
    <p class="nd-subtitle"><?php echo esc_html( nd_t( 'widget_subtitle' ) ); ?></p>

    <div class="nd-form-group">
      <label><?php echo esc_html( nd_t( 'label_widget' ) ); ?></label>
      <select id="nd-widget-select" class="nd-input">
        <option value="__new__"><?php echo esc_html( sprintf( nd_t( 'create_new_widget' ), get_bloginfo( 'name' ) ) ); ?></option>
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
      <span class="nd-btn-text"><?php echo esc_html( nd_t( 'btn_continue' ) ); ?></span>
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
        <button class="nd-btn-link nd-btn-disconnect" id="nd-btn-disconnect"><?php echo esc_html( nd_t( 'btn_logout' ) ); ?></button>
      </div>

      <div class="nd-status-row">
        <div class="nd-status-dot <?php echo $embed_on ? 'nd-dot-green' : 'nd-dot-gray'; ?>"></div>
        <span><?php echo wp_kses_post( $embed_on ? nd_t( 'chatbot_active' ) : nd_t( 'chatbot_inactive' ) ); ?></span>
        <label class="nd-toggle" title="<?php echo esc_attr( nd_t( 'toggle_title' ) ); ?>">
          <input type="checkbox" id="nd-embed-toggle" <?php checked( $embed_on ); ?>>
          <span class="nd-toggle-slider"></span>
        </label>
      </div>

      <div class="nd-widget-info">
        <div class="nd-info-label"><?php echo esc_html( nd_t( 'label_widget_id' ) ); ?></div>
        <div class="nd-info-value nd-mono"><?php echo esc_html( $widget_id ); ?></div>
        <a href="<?php echo esc_url( $api_base . '/dashboard' ); ?>" target="_blank" class="nd-btn-link"><?php echo esc_html( nd_t( 'btn_open_dashboard' ) ); ?></a>
      </div>

      <?php if ( ! $scan_done ) : ?>
      <div class="nd-scan-box" id="nd-scan-box">
        <h3><?php echo esc_html( nd_t( 'scan_box_title' ) ); ?></h3>
        <p><?php echo esc_html( nd_t( 'scan_box_desc' ) ); ?></p>

        <div class="nd-count-row">
          <div class="nd-count-item">
            <span class="nd-count-num"><?php echo $count_pages; ?></span>
            <span class="nd-count-label"><?php echo esc_html( nd_t( 'count_pages' ) ); ?></span>
          </div>
          <div class="nd-count-item">
            <span class="nd-count-num"><?php echo $count_posts; ?></span>
            <span class="nd-count-label"><?php echo esc_html( nd_t( 'count_posts' ) ); ?></span>
          </div>
          <?php if ( $has_woo ) : ?>
          <div class="nd-count-item">
            <span class="nd-count-num"><?php echo $count_prods; ?></span>
            <span class="nd-count-label"><?php echo esc_html( nd_t( 'count_products' ) ); ?></span>
          </div>
          <?php endif; ?>
        </div>

        <?php if ( ! $has_woo ) : ?>
        <div class="nd-notice nd-notice-info"><?php echo esc_html( nd_t( 'notice_no_woo' ) ); ?></div>
        <?php endif; ?>

        <button class="nd-btn nd-btn-primary nd-btn-full" id="nd-btn-scan">
          <span class="nd-btn-text"><?php echo esc_html( nd_t( 'btn_scan' ) ); ?></span>
          <span class="nd-spinner" style="display:none"></span>
        </button>
      </div>

      <!-- Progress (hidden until scan starts) -->
      <div id="nd-scan-progress" style="display:none">
        <h3><?php echo esc_html( nd_t( 'scan_in_progress_title' ) ); ?></h3>
        <div class="nd-steps">
          <div class="nd-step" id="step-pages">
            <div class="nd-step-icon">📄</div>
            <div class="nd-step-body">
              <div class="nd-step-label"><?php echo esc_html( nd_t( 'step_pages' ) ); ?></div>
              <div class="nd-step-sub" id="step-pages-sub"><?php echo esc_html( nd_t( 'step_waiting' ) ); ?></div>
            </div>
            <div class="nd-step-status" id="step-pages-status"></div>
          </div>
          <div class="nd-step" id="step-posts">
            <div class="nd-step-icon">📝</div>
            <div class="nd-step-body">
              <div class="nd-step-label"><?php echo esc_html( nd_t( 'step_posts' ) ); ?></div>
              <div class="nd-step-sub" id="step-posts-sub"><?php echo esc_html( nd_t( 'step_waiting' ) ); ?></div>
            </div>
            <div class="nd-step-status" id="step-posts-status"></div>
          </div>
          <?php if ( $has_woo ) : ?>
          <div class="nd-step" id="step-products">
            <div class="nd-step-icon">🛍️</div>
            <div class="nd-step-body">
              <div class="nd-step-label"><?php echo esc_html( nd_t( 'step_products' ) ); ?></div>
              <div class="nd-step-sub" id="step-products-sub"><?php echo esc_html( nd_t( 'step_waiting' ) ); ?></div>
            </div>
            <div class="nd-step-status" id="step-products-status"></div>
          </div>
          <?php endif; ?>
        </div>
        <div class="nd-progress-bar-wrap">
          <div class="nd-progress-bar" id="nd-progress-bar" style="width:0%"></div>
        </div>
        <div class="nd-progress-label" id="nd-progress-label"><?php echo esc_html( nd_t( 'progress_preparing' ) ); ?></div>
      </div>

      <?php else : ?>
      <!-- Scan already done -->
      <div class="nd-success-box">
        <div class="nd-success-icon">✅</div>
        <div>
          <strong><?php echo esc_html( nd_t( 'scan_complete_title' ) ); ?></strong>
          <p><?php echo esc_html( nd_t( 'scan_complete_desc' ) ); ?></p>
        </div>
        <button class="nd-btn nd-btn-secondary nd-btn-sm" id="nd-btn-rescan"><?php echo esc_html( nd_t( 'btn_rescan' ) ); ?></button>
      </div>
      <?php endif; ?>
    </div>

    <!-- Right: Embed code -->
    <div class="nd-card nd-card-secondary">
      <h3><?php echo esc_html( nd_t( 'embed_title' ) ); ?></h3>
      <p class="nd-subtitle"><?php echo esc_html( nd_t( 'embed_subtitle' ) ); ?></p>
      <div class="nd-code-block">
        <code id="nd-embed-code">&lt;script&gt;window.NeuraDeskConfig={widgetId:"<?php echo esc_js( $widget_id ); ?>"};&lt;/script&gt;
&lt;script src="<?php echo esc_url( $api_base ); ?>/widget.js" async&gt;&lt;/script&gt;</code>
      </div>
      <button class="nd-btn nd-btn-secondary nd-btn-sm" id="nd-btn-copy-embed"><?php echo esc_html( nd_t( 'btn_copy_embed' ) ); ?></button>

      <div style="margin-top:1.5rem">
        <h3><?php echo esc_html( nd_t( 'scanned_title' ) ); ?></h3>
        <ul class="nd-feature-list">
          <li>✅ <?php echo wp_kses_post( nd_t( 'scanned_pages' ) ); ?> (<?php echo $count_pages; ?>)</li>
          <li>✅ <?php echo wp_kses_post( nd_t( 'scanned_posts' ) ); ?> (<?php echo $count_posts; ?>)</li>
          <?php if ( $has_woo ) : ?>
          <li>✅ <?php echo wp_kses_post( nd_t( 'scanned_products' ) ); ?> (<?php echo $count_prods; ?>)</li>
          <?php else : ?>
          <li>⚪ <?php echo esc_html( nd_t( 'woo_inactive' ) ); ?></li>
          <?php endif; ?>
        </ul>
      </div>

      <div style="margin-top:1.5rem">
        <h3><?php echo esc_html( nd_t( 'next_steps_title' ) ); ?></h3>
        <ul class="nd-feature-list">
          <li><?php echo esc_html( nd_t( 'next_customize' ) ); ?> <a href="<?php echo esc_url( $api_base . '/dashboard' ); ?>" target="_blank" style="text-decoration:none"></a></li>
          <li><?php echo esc_html( nd_t( 'next_faq' ) ); ?></li>
          <li><?php echo esc_html( nd_t( 'next_contacts' ) ); ?></li>
        </ul>
      </div>
    </div>
  </div>

  <?php endif; ?>

  <div id="nd-scan-done-overlay" style="display:none">
    <div class="nd-scan-done-card">
      <div style="font-size:3rem;margin-bottom:0.5rem">🎉</div>
      <h2><?php echo esc_html( nd_t( 'overlay_title' ) ); ?></h2>
      <p><?php echo esc_html( nd_t( 'overlay_desc' ) ); ?></p>
      <a href="<?php echo esc_url( get_home_url() ); ?>" target="_blank" class="nd-btn nd-btn-primary"><?php echo esc_html( nd_t( 'btn_view_site' ) ); ?></a>
      <a href="<?php echo esc_url( $api_base . '/dashboard' ); ?>" target="_blank" class="nd-btn nd-btn-secondary"><?php echo esc_html( nd_t( 'btn_nd_dashboard' ) ); ?></a>
    </div>
  </div>

</div>
