# Deployment and Windows operation

لا تنشر هذه الخطوات الموقع الحي تلقائيًا. Compose يشغل نسخة محلية/ذاتية، وGitHub Actions في هذا الفرع للاختبار فقط.

## نسخة اختبار فورية ومعزولة

لا تحتاج Docker أو Supabase credentials:

```powershell
npm ci --ignore-scripts
npm run preview:test
```

افتح `http://127.0.0.1:8000`. بيانات الإدارة المحلية:

```text
username: preview-admin
password: Warehouse-Preview-2026!
```

للعامل استخدم أي اسم عربي ورقم جديد مثل `70001`، وابحث عن `منشار`. استخدم نافذتين/متصفحين لأن جلسة كل صفحة محفوظة في الذاكرة. أوقف الخادم بـ`Ctrl+C` لحذف جميع بيانات التجربة.

## أسرع تشغيل على Windows

المتطلب: Docker Desktop يعمل بوضع Linux containers.

```powershell
git switch codex/production-ready-windows
Copy-Item .env.example .env
notepad .env
docker compose config --quiet
docker compose up --detach --build --wait
Start-Process http://localhost:8080
```

في `.env` استبدل فقط:

- `SUPABASE_URL`: رابط مشروع Supabase، مثل `https://project-ref.supabase.co`.
- `SUPABASE_PUBLISHABLE_KEY`: publishable key أو legacy anon key العام. لا تستخدم service role أو secret key.

الفحص والإيقاف:

```powershell
docker compose ps
docker compose logs --follow web
Invoke-WebRequest http://localhost:8080/healthz
docker compose down
```

`docker compose down` لا يحذف volumes. لا تستخدم `--volumes` في بيئة HTTPS ذاتية مستمرة لأن `caddy_data` يحتوي شهادات ومفاتيح Caddy.

## HTTPS والاستضافة الذاتية

وجّه DNS إلى الخادم، افتح 80/443، ثم اضبط:

```dotenv
WAREHOUSE_SITE_ADDRESS=warehouse.example.com
WAREHOUSE_HTTP_PORT=80
WAREHOUSE_HTTPS_PORT=443
```

أعد `docker compose up -d --build`. Caddy يحصل على الشهادة ويجددها ويخزنها في `caddy_data`. أضف أصل الموقع إلى `ALLOWED_ORIGINS` في بيئة Edge Function فقط إذا ستتصل الواجهة مباشرة؛ مسار Caddy same-origin يحذف Origin قبل الاتصال upstream.

## التحقق قبل إصدار

```powershell
$env:NODE_OPTIONS='--use-system-ca' # عند وجود مشكلة شهادة npm المؤسسية فقط
npm ci --ignore-scripts
npm run check
npm test
docker compose --env-file .env config --quiet
docker compose up --detach --build --wait
Invoke-WebRequest http://localhost:8080/
Invoke-WebRequest http://localhost:8080/warehouse-config.js
docker compose down
```

## Supabase release منفصل

لم يُنفذ في هذه المهمة. عند اعتماد إصدار قاعدة/Function:

1. خذ backup وتأكد أن المشروع المقصود staging، ثم production صراحة.
2. استخدم إصدار CLI موثقًا واكتشف الأوامر بـ`supabase --help`.
3. شغّل migration list/advisors واختبارات staging.
4. طبق migrations بالترتيب وانشر `warehouse-api` مع `verify_jwt=true`.
5. تأكد أن `SUPABASE_SERVICE_ROLE_KEY` و`ALLOWED_ORIGINS` في Edge secrets، لا في Compose.
6. نفذ smoke transaction قابلة للـrollback، ثم راقب الأخطاء والأقفال.

لا توجد GitHub Action تنشر Supabase. Workflow Pages القديم لا يعمل إلا على `main`; لم يُشغّل أو يُعدّل للنشر هنا.

## Rollback

- الواجهة/Caddy: شغّل صورة commit سابقة؛ لا تتغير البيانات.
- Edge Function: أعد نشر النسخة السابقة المتوافقة مع المخطط.
- قاعدة البيانات: لا تستخدم down/destructive migration. أضف forward-fix migration بعد backup ومراجعة الأثر.
