import { createWarehouseHandler } from './handler.mjs';

Deno.serve(createWarehouseHandler({ env: (name: string) => Deno.env.get(name) }));
