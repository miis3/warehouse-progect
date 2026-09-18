# Security

آخر مراجعة: 2026-09-17

## الأسرار والمفاتيح

- ممنوع وضع `SUPABASE_SERVICE_ROLE_KEY`, `sb_secret_*`, كلمات المرور، setup/session tokens، أو database URLs في Git أو browser أو Docker build args.
- `.env` متجاهل. `.env.example` قيم بديلة فقط.
- الحاوية تقرأ `SUPABASE_PUBLISHABLE_KEY` الآمن للنشر وترسله في `apikey` فقط. لا ترسله كـBearer لأن مفاتيح `sb_publishable_*` ليست JWT.
- Edge Function وحدها تقرأ `SUPABASE_SERVICE_ROLE_KEY` من بيئة Supabase. المفتاح القديم `anon` في نسخة Pages عام وليس سرًا، لكن الانتقال إلى publishable key موصى به عند دورة النشر التالية.

## Auth وJWT والجلسات

- بوابة Edge تحتفظ بـ`verify_jwt=true`; التطبيق يضيف فوقها جلسة مستودع عشوائية 256-bit مخزنة كتجزئة في PostgreSQL.
- خمول الجلسة 15 دقيقة وعمرها الأقصى 8 ساعات. التوكن في ذاكرة الصفحة فقط.
- staff passwords تتحقق عبر Supabase Auth ولا تدخل قاعدة المستودع.
- دخول العامل بالاسم/الرقم ضعيف نسبيًا ومقبول فقط لأن الاستلام يحتاج اعتماد أمين. لا يُعامل كإثبات هوية قوي.

## Authorization وIDOR

- كل private action يتحقق من الجلسة النشطة والدور داخل قاعدة البيانات.
- العامل مقيد بـ`worker_id=v_actor` للقوائم والسجل والإلغاء والإرجاع.
- الأمين/المدير فقط يعتمد ويعدّل المخزون؛ إدارة الحسابات والعمال للمدير فقط.
- معرّفات UUID القادمة من العميل لا تمنح صلاحية بمفردها؛ RPC يعيد تحميل الصف ويفحص الملكية/الدور والحالة.
- `anon` و`authenticated` وحتى `service_role` لا تملك وصول جدول مباشر؛ الخدمة تصل عبر RPC مسموح فقط.

## Injection وXSS

- لا يوجد SQL نصي من إدخال المستخدم. Edge تستدعي أسماء RPC allow-listed وPostgREST يمرر arguments كقيم.
- dynamic SQL في migrations يستخدم identifiers من catalog مع `%I` فقط.
- الواجهة تهرب القيم التشغيلية قبل إدراجها في HTML؛ اختبارات الواجهة تغطي المسارات الرئيسية.
- Caddy يضيف CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`) ورؤوس منع MIME sniffing/clickjacking. `style-src 'unsafe-inline'` باقٍ لأن الواجهة الحالية تستخدم style attributes للحركة والمواقع.

## Race conditions وسلامة السجل

- الأقفال مرتبة، والاعتماد بالكامل داخل معاملة، وقيد فريد يمنع ازدواج العهدة.
- mutations الموظفين serialized لمنع مديرين من تغيير صلاحيات بعضهما بحالة قديمة.
- audit وloan history محميان triggers؛ التصحيح يكون بحدث جديد لا بإعادة كتابة التاريخ.

## حدود الشبكة والحاوية

- Caddy يقبل endpoint واحدًا للـAPI ويحذف `Origin` و`Authorization` القادمين قبل proxy، ثم يضيف publishable `apikey` من بيئته.
- الحاوية read-only، بلا امتيازات إضافية عدا bind، ومع `no-new-privileges` وhealthcheck.
- عمليات API `POST` فقط، JSON بحد 100KB، مع rate limits و`Cache-Control: no-store`.

## نسخة الاختبار المحلية

- `npm run preview:test` يرتبط بـ`127.0.0.1` فقط، ولا يعرض الخدمة على الشبكة المحلية.
- لا يقرأ `.env` ولا Supabase keys ولا يتصل بخدمة بعيدة؛ قاعدة PGlite مؤقتة في الذاكرة.
- كلمة مرور `Warehouse-Preview-2026!` fixture معلنة للاختبار ولا تستخدم خارج Preview.
- يقدم نفس CSP ورؤوس منع التخزين/clickjacking الأساسية، ويعيد إنشاء البيانات عند كل تشغيل.

## نتائج المراجعة

- Secrets: لا يوجد secret جديد، ولا service role في browser/container.
- Auth/JWT: الحدود صحيحة؛ مخاطر worker login موثقة.
- RLS/privileges: مفعلة ومغلقة باختبارات شاملة.
- IDOR/SQL injection: لم يُعثر على مسار تجاوز ضمن actions الحالية.
- XSS: escaping موجود وCSP يضيف defense-in-depth؛ يلزم إبقاء الاختبارات عند أي HTML جديد.
- Races: الأقفال والقيود تمنع ازدواج الاعتماد؛ اختبار PGlite ليس load test متعدد الاتصالات.
- Audit: ثابت على مستوى التطبيق/DB؛ صلاحيات مالك المشروع خارج هذا الضمان.

## مراجع تشغيلية

- [Supabase: Securing your data](https://supabase.com/docs/guides/database/secure-data)
- [Supabase: Securing your API](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase: Edge Function authorization headers](https://supabase.com/docs/guides/functions/auth-headers)
