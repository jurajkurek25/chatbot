<?php
/**
 * Plugin Name: NeuraDeskApp Chatbot
 * Plugin URI:  https://neuradesk.online
 * Description: Automatická integrácia AI chatbota – prihlás sa, plugin naskenuje celý web a nasadí sa sám.
 * Version:     1.0.3
 * Author:      NeuraDeskApp
 * License:     GPL-2.0+
 * Text Domain: neuradesk-chatbot
 */

defined( 'ABSPATH' ) || exit;

define( 'NEURADESK_VERSION', '1.0.3' );
define( 'NEURADESK_DIR',     plugin_dir_path( __FILE__ ) );
define( 'NEURADESK_URL',     plugin_dir_url( __FILE__ ) );

/* ── i18n helpers ────────────────────────────────────────────────────────── */

/**
 * Load translation strings for the current WordPress locale.
 * Falls back to sk.json if no matching language file exists.
 */
function neuradesk_load_translations(): array {
    $lang_dir = NEURADESK_DIR . 'languages/';
    $locale   = get_locale(); // e.g. "de_DE", "fr_FR", "sk_SK"

    // Extract 2-letter language code
    $lang  = strtolower( substr( $locale, 0, 2 ) );
    $file  = $lang_dir . $lang . '.json';

    // Try exact match first, then fallback to Slovak master
    if ( $lang !== 'sk' && file_exists( $file ) ) {
        $data = json_decode( file_get_contents( $file ), true );
        if ( is_array( $data ) ) return $data;
    }

    $sk_file = $lang_dir . 'sk.json';
    if ( file_exists( $sk_file ) ) {
        $data = json_decode( file_get_contents( $sk_file ), true );
        if ( is_array( $data ) ) return $data;
    }

    return [];
}

/**
 * Return a translated plugin string by key.
 * Supports {placeholder} substitution: nd_t('key', ['placeholder' => 'value'])
 */
function nd_t( string $key, array $args = [] ): string {
    static $strings = null;
    if ( $strings === null ) $strings = neuradesk_load_translations();

    $val = $strings[ $key ] ?? $key;

    foreach ( $args as $placeholder => $replacement ) {
        $val = str_replace( '{' . $placeholder . '}', $replacement, $val );
    }

    return $val;
}

require_once NEURADESK_DIR . 'includes/class-neuradesk-api.php';
require_once NEURADESK_DIR . 'includes/class-neuradesk-scanner.php';

/* ── Admin menu ──────────────────────────────────────────────────── */
add_action( 'admin_menu', function () {
    add_menu_page(
        'NeuraDeskApp',
        'NeuraDeskApp',
        'manage_options',
        'neuradesk-chatbot',
        'neuradesk_render_admin_page',
        'data:image/svg+xml;base64,' . base64_encode( '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#a7aaad" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>' ),
        80
    );
} );

add_action( 'admin_enqueue_scripts', function ( $hook ) {
    if ( $hook !== 'toplevel_page_neuradesk-chatbot' ) return;
    wp_enqueue_style(  'neuradesk-admin', NEURADESK_URL . 'admin/css/admin.css', [], NEURADESK_VERSION );
    wp_enqueue_script( 'neuradesk-admin', NEURADESK_URL . 'admin/js/admin.js',  [ 'jquery' ], NEURADESK_VERSION, true );
    wp_localize_script( 'neuradesk-admin', 'NeuraDesk', [
        'ajax_url' => admin_url( 'admin-ajax.php' ),
        'nonce'    => wp_create_nonce( 'neuradesk_nonce' ),
        'api_base' => get_option( 'neuradesk_api_base', 'https://neuradesk.online' ),
        'token'    => get_option( 'neuradesk_token', '' ),
        'widget_id'=> get_option( 'neuradesk_widget_id', '' ),
        'user_name'=> get_option( 'neuradesk_user_name', '' ),
        'site_name'=> get_bloginfo( 'name' ),
        't'        => neuradesk_load_translations(),
    ] );
} );

/* ── Admin page render ───────────────────────────────────────────── */
function neuradesk_render_admin_page() {
    require_once NEURADESK_DIR . 'admin/admin-page.php';
}

/* ── AJAX: login ─────────────────────────────────────────────────── */
add_action( 'wp_ajax_neuradesk_login', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );

    $api_base = esc_url_raw( sanitize_text_field( $_POST['api_base'] ?? 'https://neuradesk.online' ) );
    $email    = sanitize_email( $_POST['email'] ?? '' );
    $password = $_POST['password'] ?? '';

    if ( ! $email || ! $password ) {
        wp_send_json_error( [ 'message' => nd_t( 'err_email_password_required' ) ] );
    }

    $api  = new NeuraDeskAPI( $api_base, '' );
    $resp = $api->login( $email, $password );

    if ( is_wp_error( $resp ) ) {
        wp_send_json_error( [ 'message' => $resp->get_error_message() ] );
    }

    update_option( 'neuradesk_api_base',  $api_base );
    update_option( 'neuradesk_token',     $resp['token'] );
    update_option( 'neuradesk_user_name', $resp['user']['name'] );
    update_option( 'neuradesk_user_email', $resp['user']['email'] );
    // clear previous widget binding on re-login
    delete_option( 'neuradesk_widget_id' );
    delete_option( 'neuradesk_scan_done' );

    wp_send_json_success( [
        'user_name' => $resp['user']['name'],
        'widgets'   => neuradesk_get_widgets( $api_base, $resp['token'] ),
    ] );
} );

/* ── AJAX: select or create widget ──────────────────────────────── */
add_action( 'wp_ajax_neuradesk_set_widget', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );

    $api_base  = get_option( 'neuradesk_api_base', 'https://neuradesk.online' );
    $token     = get_option( 'neuradesk_token', '' );
    $widget_id = sanitize_text_field( $_POST['widget_id'] ?? '' );
    $site_name = sanitize_text_field( $_POST['site_name'] ?? get_bloginfo( 'name' ) );

    if ( ! $token ) {
        wp_send_json_error( [ 'message' => nd_t( 'err_not_logged_in' ) ] );
    }

    $api = new NeuraDeskAPI( $api_base, $token );

    if ( $widget_id === '__new__' ) {
        $result = $api->create_widget( $site_name );
        if ( is_wp_error( $result ) ) {
            wp_send_json_error( [ 'message' => $result->get_error_message() ] );
        }
        $widget_id = $result['id'];
    }

    update_option( 'neuradesk_widget_id', $widget_id );
    update_option( 'neuradesk_embed_enabled', 1 );

    wp_send_json_success( [ 'widget_id' => $widget_id ] );
} );

/* ── AJAX: scan batch ────────────────────────────────────────────── */
add_action( 'wp_ajax_neuradesk_scan_batch', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );

    $api_base  = get_option( 'neuradesk_api_base', 'https://neuradesk.online' );
    $token     = get_option( 'neuradesk_token', '' );
    $widget_id = get_option( 'neuradesk_widget_id', '' );

    if ( ! $token || ! $widget_id ) {
        wp_send_json_error( [ 'message' => nd_t( 'err_not_logged_in_or_no_widget' ) ] );
    }

    $type   = sanitize_text_field( $_POST['type'] ?? 'pages' );
    $offset = absint( $_POST['offset'] ?? 0 );
    $limit  = 10;

    $api     = new NeuraDeskAPI( $api_base, $token );
    $scanner = new NeuraDeskScanner();
    $result  = [ 'imported' => 0, 'skipped' => 0, 'errors' => [] ];

    switch ( $type ) {
        case 'pages':
            $items = $scanner->get_pages( $offset, $limit );
            foreach ( $items as $item ) {
                $r = $api->add_knowledge( $widget_id, $item['title'], $item['content'] );
                if ( is_wp_error( $r ) ) { $result['errors'][] = $item['title']; $result['skipped']++; }
                else $result['imported']++;
            }
            $result['has_more'] = count( $items ) === $limit;
            break;

        case 'posts':
            $items = $scanner->get_posts( $offset, $limit );
            foreach ( $items as $item ) {
                $r = $api->add_knowledge( $widget_id, $item['title'], $item['content'] );
                if ( is_wp_error( $r ) ) { $result['errors'][] = $item['title']; $result['skipped']++; }
                else $result['imported']++;
            }
            $result['has_more'] = count( $items ) === $limit;
            break;

        case 'products':
            if ( ! class_exists( 'WooCommerce' ) ) {
                $result['has_more'] = false;
                $result['skipped_reason'] = 'woocommerce_not_active';
                break;
            }
            $items = $scanner->get_products( $offset, $limit );
            foreach ( $items as $item ) {
                // Add as knowledge item
                $r = $api->add_knowledge( $widget_id, $item['title'], $item['knowledge_text'] );
                if ( is_wp_error( $r ) ) { $result['errors'][] = $item['title']; $result['skipped']++; }
                else $result['imported']++;

                // Also add as product card
                $api->add_product( $widget_id, $item );
            }
            $result['has_more'] = count( $items ) === $limit;
            break;
    }

    // Mark scan done on last batch
    if ( ! $result['has_more'] && $type === 'products' ) {
        update_option( 'neuradesk_scan_done', 1 );
    }

    wp_send_json_success( $result );
} );

/* ── AJAX: save settings ─────────────────────────────────────────── */
add_action( 'wp_ajax_neuradesk_save_settings', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );
    update_option( 'neuradesk_embed_enabled', absint( $_POST['embed_enabled'] ?? 1 ) );
    wp_send_json_success();
} );

/* ── AJAX: mark scan done ────────────────────────────────────────── */
add_action( 'wp_ajax_neuradesk_mark_scan_done', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );
    update_option( 'neuradesk_scan_done', 1 );
    wp_send_json_success();
} );

/* ── AJAX: reset scan (for re-scan) ──────────────────────────────── */
add_action( 'wp_ajax_neuradesk_reset_scan', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );
    delete_option( 'neuradesk_scan_done' );
    wp_send_json_success();
} );

/* ── AJAX: disconnect ────────────────────────────────────────────── */
add_action( 'wp_ajax_neuradesk_disconnect', function () {
    check_ajax_referer( 'neuradesk_nonce', 'nonce' );
    delete_option( 'neuradesk_token' );
    delete_option( 'neuradesk_widget_id' );
    delete_option( 'neuradesk_user_name' );
    delete_option( 'neuradesk_user_email' );
    delete_option( 'neuradesk_scan_done' );
    delete_option( 'neuradesk_embed_enabled' );
    wp_send_json_success();
} );

/* ── Widget embed ─────────────────────────────────────────────────── */

/**
 * Returns true when the widget should be injected on this request.
 * Called both at hook-registration time and inside the ob_start callback.
 */
function neuradesk_should_inject() {
    if ( is_admin() ) return false;
    if ( is_feed() ) return false;          // Don't corrupt RSS/Atom feeds
    if ( ! get_option( 'neuradesk_embed_enabled', 0 ) ) return false;
    if ( ! get_option( 'neuradesk_widget_id', '' ) ) return false;
    return true;
}

/**
 * Builds the two <script> tags that load the widget.
 */
function neuradesk_embed_html() {
    $widget_id = get_option( 'neuradesk_widget_id', '' );
    $api_base  = get_option( 'neuradesk_api_base', 'https://neuradesk.online' );
    $config    = wp_json_encode( [ 'widgetId' => $widget_id ] );
    $src       = esc_url( trailingslashit( $api_base ) . 'widget.js' );
    $origin    = esc_url( untrailingslashit( $api_base ) );
    return "\n<link rel=\"preconnect\" href=\"{$origin}\">\n"
         . "<script>window.NeuraDeskConfig={$config};</script>\n"
         . "<script src=\"{$src}\" async defer></script>\n";
}

// ── Method 1: wp_footer (priority 99999) ────────────────────────────
// Covers: standard themes, Elementor Full Width / Hello Elementor,
// Divi, Avada, Bricks, GeneratePress, Astra, OceanWP …
// Fires last in the footer, after all other scripts.
add_action( 'wp_footer', function () {
    if ( ! neuradesk_should_inject() ) return;
    // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
    echo neuradesk_embed_html();
}, 99999 );

// ── Method 2: wp_head fallback (priority 99999) ──────────────────────
// Extra safety: async/defer scripts in <head> load without blocking.
// Deduplication: only inject here if wp_footer didn't already run
// (it won't have at this point, but we flag it for the ob callback).
add_action( 'wp_head', function () {
    if ( ! neuradesk_should_inject() ) return;
    // Only inject via wp_head if wp_footer is not hooked at all
    // (some heavily customised themes skip get_footer() entirely).
    if ( ! has_action( 'wp_footer' ) ) {
        // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
        echo neuradesk_embed_html();
    }
}, 99999 );

// ── Method 3: output-buffer catch-all (template_redirect) ────────────
// Covers: Elementor Canvas, Oxygen Builder, Breakdance, and any
// other builder/setup that never calls wp_footer().
// Checks for '<html' so it only modifies real HTML pages, never
// XML feeds, REST JSON, or sitemaps that slip past is_feed().
add_action( 'template_redirect', function () {
    if ( ! neuradesk_should_inject() ) return;

    ob_start( function ( $html ) {
        // Skip non-HTML responses (REST API, sitemaps, etc.)
        if ( stripos( $html, '<html' ) === false ) return $html;

        // Skip if already injected (by wp_footer or wp_head above).
        if ( strpos( $html, 'NeuraDeskConfig' ) !== false ) return $html;

        $inject = neuradesk_embed_html();

        if ( stripos( $html, '</body>' ) !== false ) {
            return str_ireplace( '</body>', $inject . '</body>', $html );
        }
        if ( stripos( $html, '</html>' ) !== false ) {
            return str_ireplace( '</html>', $inject . '</html>', $html );
        }
        // Last resort: append (handles pages with non-standard structure)
        return $html . $inject;
    } );
} );

/* ── Helpers ─────────────────────────────────────────────────────── */
function neuradesk_get_widgets( $api_base, $token ) {
    $api  = new NeuraDeskAPI( $api_base, $token );
    $list = $api->get_widgets();
    if ( is_wp_error( $list ) ) return [];
    return array_map( fn( $w ) => [ 'id' => $w['id'], 'name' => $w['name'] ], $list );
}
