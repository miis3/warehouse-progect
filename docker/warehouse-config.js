// Docker uses a same-origin reverse proxy. Caddy adds the public Supabase key
// upstream; privileged keys remain only in the Supabase Edge Function runtime.
window.WAREHOUSE_CONFIG = Object.freeze({apiUrl: '/api/warehouse', gatewayKey: ''});
