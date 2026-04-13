<?php
defined( 'ABSPATH' ) || exit;

class NeuraDeskAPI {

    private string $base;
    private string $token;

    public function __construct( string $base, string $token ) {
        $this->base  = rtrim( $base, '/' );
        $this->token = $token;
    }

    /* ── Auth ──────────────────────────────────────────────────── */
    public function login( string $email, string $password ) {
        return $this->post( '/api/auth/login', [
            'email'    => $email,
            'password' => $password,
        ], false );
    }

    /* ── Widgets ───────────────────────────────────────────────── */
    public function get_widgets() {
        return $this->get( '/api/widgets' );
    }

    public function create_widget( string $site_name ) {
        return $this->post( '/api/widgets', [
            'name'            => $site_name . ' – WordPress',
            'bot_name'        => 'Asistent',
            'welcome_message' => nd_t( 'api_welcome_message' ),
            'goals'           => nd_t( 'api_widget_goals', [ 'site' => $site_name ] ),
            'cta_type'        => 'contact',
        ] );
    }

    /* ── Knowledge ─────────────────────────────────────────────── */
    public function add_knowledge( string $widget_id, string $title, string $content ) {
        if ( ! $content || strlen( trim( $content ) ) < 20 ) {
            return new WP_Error( 'too_short', 'Content too short' );
        }
        // Truncate to 12 000 chars (API limit safety)
        $content = substr( $content, 0, 12000 );
        return $this->post( "/api/knowledge/{$widget_id}/text", [
            'title'   => $title,
            'content' => $content,
        ] );
    }

    /* ── Products ──────────────────────────────────────────────── */
    public function add_product( string $widget_id, array $item ) {
        $body = [
            'name'        => $item['title'],
            'type'        => $item['product_type'] ?? 'physical',
            'description' => $item['description'] ?? '',
            'for_whom'    => '',
            'benefits'    => '',
            'price'       => $item['price'] ?? null,
            'currency'    => $item['currency'] ?? 'EUR',
            'landing_url' => $item['url'] ?? null,
            'cta_text'    => nd_t( 'api_view_product' ),
            'tags'        => $item['categories'] ?? '',
            'priority'    => 0,
            'active'      => 1,
        ];
        return $this->post( "/api/products/{$widget_id}", $body );
    }

    /* ── HTTP helpers ──────────────────────────────────────────── */
    private function get( string $path ) {
        $response = wp_remote_get( $this->base . $path, [
            'timeout' => 30,
            'headers' => $this->headers(),
        ] );
        return $this->parse( $response );
    }

    private function post( string $path, array $body, bool $auth = true ) {
        $response = wp_remote_post( $this->base . $path, [
            'timeout' => 30,
            'headers' => $auth ? $this->headers() : [ 'Content-Type' => 'application/json' ],
            'body'    => wp_json_encode( $body ),
        ] );
        return $this->parse( $response );
    }

    private function headers(): array {
        return [
            'Content-Type'  => 'application/json',
            'Authorization' => 'Bearer ' . $this->token,
        ];
    }

    private function parse( $response ) {
        if ( is_wp_error( $response ) ) return $response;

        $code = wp_remote_retrieve_response_code( $response );
        $body = json_decode( wp_remote_retrieve_body( $response ), true );

        if ( $code >= 400 ) {
            $msg = $body['error'] ?? "HTTP error {$code}";
            return new WP_Error( 'api_error', $msg );
        }

        return $body;
    }
}
