<?php
defined( 'ABSPATH' ) || exit;

class NeuraDeskScanner {

    /* ── Pages ─────────────────────────────────────────────────── */
    public function get_pages( int $offset = 0, int $limit = 10 ): array {
        $query = new WP_Query( [
            'post_type'      => 'page',
            'post_status'    => 'publish',
            'posts_per_page' => $limit,
            'offset'         => $offset,
            'orderby'        => 'menu_order',
            'order'          => 'ASC',
            'no_found_rows'  => true,
        ] );

        return $this->extract_posts( $query->posts );
    }

    /* ── Posts ─────────────────────────────────────────────────── */
    public function get_posts( int $offset = 0, int $limit = 10 ): array {
        $query = new WP_Query( [
            'post_type'      => 'post',
            'post_status'    => 'publish',
            'posts_per_page' => $limit,
            'offset'         => $offset,
            'orderby'        => 'date',
            'order'          => 'DESC',
            'no_found_rows'  => true,
        ] );

        return $this->extract_posts( $query->posts );
    }

    /* ── WooCommerce Products ──────────────────────────────────── */
    public function get_products( int $offset = 0, int $limit = 10 ): array {
        if ( ! class_exists( 'WooCommerce' ) ) return [];

        $query = new WP_Query( [
            'post_type'      => 'product',
            'post_status'    => 'publish',
            'posts_per_page' => $limit,
            'offset'         => $offset,
            'orderby'        => 'date',
            'order'          => 'DESC',
            'no_found_rows'  => true,
        ] );

        $products = [];
        foreach ( $query->posts as $post ) {
            $product = wc_get_product( $post->ID );
            if ( ! $product ) continue;

            $price    = $product->get_price();
            $currency = get_woocommerce_currency();
            $cats     = wp_list_pluck(
                get_the_terms( $post->ID, 'product_cat' ) ?: [],
                'name'
            );

            // Short description (excerpt)
            $short_desc = wp_strip_all_tags( $product->get_short_description() );
            // Full description
            $full_desc  = $this->clean_content( $post->post_content );

            $knowledge_parts = [ $product->get_name() ];
            if ( $short_desc ) $knowledge_parts[] = $short_desc;
            if ( $full_desc )  $knowledge_parts[] = $full_desc;
            if ( $price )      $knowledge_parts[] = "Cena: {$price} {$currency}";
            if ( $cats )       $knowledge_parts[] = "Kategórie: " . implode( ', ', $cats );
            if ( $product->get_sku() ) $knowledge_parts[] = "SKU: " . $product->get_sku();

            $products[] = [
                'title'          => $product->get_name(),
                'description'    => $short_desc ?: $full_desc,
                'knowledge_text' => implode( "\n\n", $knowledge_parts ),
                'price'          => $price ? (float) $price : null,
                'currency'       => $currency,
                'url'            => get_permalink( $post->ID ),
                'categories'     => implode( ', ', $cats ),
                'product_type'   => 'physical',
            ];
        }

        return $products;
    }

    /* ── Count helpers (for progress display) ─────────────────── */
    public function count_pages(): int {
        return (int) wp_count_posts( 'page' )->publish;
    }

    public function count_posts(): int {
        return (int) wp_count_posts( 'post' )->publish;
    }

    public function count_products(): int {
        if ( ! class_exists( 'WooCommerce' ) ) return 0;
        return (int) wp_count_posts( 'product' )->publish;
    }

    /* ── Helpers ───────────────────────────────────────────────── */
    private function extract_posts( array $posts ): array {
        $result = [];
        foreach ( $posts as $post ) {
            $content = $this->clean_content( $post->post_content );
            if ( strlen( $content ) < 20 ) continue; // skip empty pages
            $result[] = [
                'title'   => $post->post_title,
                'content' => $content,
                'url'     => get_permalink( $post->ID ),
            ];
        }
        return $result;
    }

    private function clean_content( string $raw ): string {
        // Apply shortcodes then strip HTML
        $processed = do_shortcode( $raw );
        $text      = wp_strip_all_tags( $processed );
        // Collapse whitespace
        $text      = preg_replace( '/\s{3,}/', "\n\n", $text );
        return trim( $text );
    }
}
