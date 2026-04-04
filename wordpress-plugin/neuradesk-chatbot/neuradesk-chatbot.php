<?php
/**
 * Plugin Name: NeuraDeskApp Chatbot
 * Plugin URI:  https://neuradesk.online
 * Description: Automatická integrácia AI chatbota – prihlás sa, plugin naskenuje celý web a nasadí sa sám.
 * Version:     1.0.0
 * Author:      NeuraDeskApp
 * License:     GPL-2.0+
 * Text Domain: neuradesk-chatbot
 */

defined( 'ABSPATH' ) || exit;

define( 'NEURADESK_VERSION', '1.0.0' );
define( 'NEURADESK_DIR',     plugin_dir_path( __FILE__ ) );
define( 'NEURADESK_URL',     plugin_dir_url( __FILE__ ) );

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
        wp_send_json_error( [ 'message' => 'Email a heslo sú povinné.' ] );
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
        wp_send_json_error( [ 'message' => 'Nie ste prihlásený.' ] );
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
        wp_send_json_error( [ 'message' => 'Nie ste prihlásený alebo nie je vybraný widget.' ] );
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
add_action( 'wp_footer', function () {
    if ( ! get_option( 'neuradesk_embed_enabled', 0 ) ) return;
    $widget_id = get_option( 'neuradesk_widget_id', '' );
    $api_base  = get_option( 'neuradesk_api_base', 'https://neuradesk.online' );
    if ( ! $widget_id ) return;
    ?>
    <script>
      window.NeuraDeskConfig = { widgetId: <?php echo wp_json_encode( $widget_id ); ?> };
    </script>
    <script src="<?php echo esc_url( trailingslashit( $api_base ) . 'widget.js' ); ?>" async></script>
    <?php
} );

/* ── Helpers ─────────────────────────────────────────────────────── */
function neuradesk_get_widgets( $api_base, $token ) {
    $api  = new NeuraDeskAPI( $api_base, $token );
    $list = $api->get_widgets();
    if ( is_wp_error( $list ) ) return [];
    return array_map( fn( $w ) => [ 'id' => $w['id'], 'name' => $w['name'] ], $list );
}
