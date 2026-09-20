import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');

test('production truth files and container boundary stay complete',()=>{
  for(const file of ['AGENTS.md','PROJECT_STATE.md','ARCHITECTURE.md','DATABASE.md','WORKFLOWS.md','SECURITY.md','DEPLOYMENT.md','CHANGELOG.md']){
    assert.ok(existsSync(resolve(root,file)),`${file} is required`);
  }

  const dockerfile=read('Dockerfile');
  assert.match(dockerfile,/^FROM caddy:2\.11\.4-alpine$/m);
  assert.match(dockerfile,/COPY warehouse-project\/site\/dist \/srv/);

  const compose=read('compose.yaml');
  assert.match(compose,/read_only:\s*true/);
  assert.match(compose,/no-new-privileges:true/);
  assert.match(compose,/SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(compose,/SERVICE_ROLE|sb_secret_/i);

  const caddy=read('docker/Caddyfile');
  assert.match(caddy,/handle \/api\/warehouse/);
  assert.match(caddy,/\/functions\/v1\/warehouse-api/);
  assert.match(caddy,/Content-Security-Policy/);
  assert.match(caddy,/frame-ancestors 'none'/);
  assert.match(caddy,/header_up Authorization "Bearer \{\$SUPABASE_ANON_KEY\}"/);
  assert.match(compose,/SUPABASE_ANON_KEY/);
  assert.doesNotMatch(caddy,/Bearer \{\$SUPABASE_PUBLISHABLE_KEY\}/);
  assert.doesNotMatch(caddy,/SERVICE_ROLE|sb_secret_/i);

  const runtimeConfig=read('docker/warehouse-config.js');
  assert.match(runtimeConfig,/apiUrl:\s*['"]\/api\/warehouse['"]/);
  assert.match(runtimeConfig,/gatewayKey:\s*['"]['"]/);

  const example=read('.env.example');
  assert.match(example,/SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me/);
  assert.doesNotMatch(example,/service_role|sb_secret_|eyJ[a-zA-Z0-9_-]+\./i);
});
