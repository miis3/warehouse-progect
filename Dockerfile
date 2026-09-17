FROM caddy:2.11.4-alpine

LABEL org.opencontainers.image.title="Warehouse management"
LABEL org.opencontainers.image.description="Arabic warehouse UI with a hardened Supabase reverse proxy"

COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY warehouse-project/site/dist /srv
COPY docker/warehouse-config.js /srv/warehouse-config.js

EXPOSE 80 443 443/udp
