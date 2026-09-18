# Architecture

## الشكل النهائي

```text
Browser (Arabic RTL UI, in-memory warehouse session)
        |
        | same-origin POST /api/warehouse
        v
Caddy container
  - static files from /srv
  - security headers and compression
  - optional automatic HTTPS
  - adds only the Supabase publishable key
        |
        | HTTPS /functions/v1/warehouse-api
        v
Supabase Edge Function (warehouse-api)
  - CORS, size limits, rate limits, input validation
  - staff authentication through Supabase Auth
  - opaque warehouse sessions
  - service role available only in this runtime
        |
        | allow-listed RPC calls
        v
Supabase PostgreSQL
  - private warehouse schema
  - service-only public RPC boundary
  - RLS + revoked direct grants
  - transactional locks and immutable audit history
```

## المكونات

- `warehouse-project/site/dist`: الواجهة الحالية بلا build step. تظل ملفات التصميم والبيانات والصور والبحث والخريطة وQR كما هي.
- `docker/warehouse-config.js`: إعداد Docker يشير إلى proxy نسبي، ولا يحتوي مفتاحًا.
- `docker/Caddyfile`: يقدم الواجهة ويعكس endpoint واحدًا إلى Supabase. لا يتصل PostgreSQL مباشرة.
- `supabase/functions/warehouse-api`: حدود HTTP المحمولة والمختبرة. وحدها تقرأ `SUPABASE_SERVICE_ROLE_KEY` من بيئة Supabase.
- `supabase/migrations`: المصدر القانوني للمخطط والصلاحيات وبيانات المخزون المصدرية.
- `tests`: اختبارات قاعدة وEdge وواجهة ومخزون وموظفين وبنية إنتاج.
- `scripts/test-preview.mjs`: محاكي تكامل محلي للاختبار اليدوي؛ يقدم الواجهة ويشغل نفس handler فوق PostgreSQL-compatible PGlite مؤقتة. لا يدخل مسار الإنتاج ولا يتصل بـSupabase.

## مسار Preview المعزول

```text
Browser on 127.0.0.1:8000
  -> local Node static/API adapter
  -> production warehouse Edge handler
  -> in-memory PGlite with all committed migrations
```

هذا المسار للاختبار اليدوي فقط. يعيد إنشاء قاعدة نظيفة في كل تشغيل، ويرتبط بالـloopback ولا يحتوي Supabase keys.

## قرار Next.js

تم تقييم الانتقال ورفضه حاليًا للأسباب التالية:

- الواجهة static وتعمل دون Node runtime أو build pipeline، ما يقلل سطح الأعطال والصيانة على Windows.
- منطق العرض موزع في واجهة DOM كبيرة مختبرة، ونقله إلى React/Next.js إعادة بناء لا انتقال تدريجي صغير.
- SSR لا يقدم قيمة واضحة لخريطة داخلية وتطبيق يعتمد API منفصلًا؛ المصادقة الحالية ليست جلسة Supabase في المتصفح.
- Caddy يحل المتطلبات التشغيلية الفعلية (التقديم، proxy، HTTPS، headers) دون تغيير الواجهة.

إعادة التقييم تصبح منطقية فقط عند الحاجة إلى routing معقد، SSR، حزمة مكونات مشتركة، أو فريق يعتمد React؛ وعندها يبدأ بمسار واحد خلف اختبارات التكافؤ، لا بإعادة كتابة شاملة.

## حدود الثقة

- المتصفح غير موثوق، وكل المعرفات والطلبات تعاد مراجعتها داخل RPC.
- Caddy ليس مخزن أسرار ولا يملك صلاحيات قاعدة؛ مفتاحه publishable فقط.
- Edge Function هي البوابة ذات الامتياز، لكنها لا تنفذ SQL حرًا؛ تستدعي أسماء RPC ثابتة.
- PostgreSQL هو الضامن النهائي للملكية والصلاحيات والذرية وحماية السجل.
