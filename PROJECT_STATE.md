# حالة المشروع

آخر تحديث: 2026-09-18

## الحالة الحالية

- فرع العمل: `codex/production-ready-windows`، مبني على `cb0a96c` من `feature/warehouse-management`.
- `main` والنشر الحي لم يتغيرا.
- الواجهة العربية RTL الحالية محفوظة مع الخريطة والصناديق والبحث والصور وQR/الباركود.
- التطبيق قابل للبناء كحاوية Caddy وتشغيله عبر Docker Compose على Windows.
- قاعدة البيانات هي Supabase/PostgreSQL الحالية، والخدمة الخلفية هي `warehouse-api` Edge Function. لم تُنفذ أي عملية على قاعدة بعيدة ولم تتغير بيانات حقيقية.
- Next.js غير معتمد: إعادة كتابة الواجهة الحالية لن تضيف فائدة تساوي خطر كسر السلوك القائم. القرار موثق في `ARCHITECTURE.md`.

## التحقق

Baseline عند `cb0a96c`:

- `npm ci`: نجح بعد استخدام مخزن شهادات Windows (`NODE_OPTIONS=--use-system-ca`).
- `npm run check`: ناجح.
- `npm test`: 16/16 ناجح.
- تدقيق npm: صفر ثغرات معروفة.

التحقق النهائي على جهاز العمل:

- `npm run check`: ناجح.
- `npm test`: 18/18 ناجح، منها اختبارات RLS/فهارس FK وبنية الإنتاج.
- `npm audit --omit=dev`: صفر ثغرات معروفة.
- `git diff --check`: ناجح (تحذيرات تحويل LF/CRLF فقط من إعداد Git على Windows).
- Prettier لفات YAML/JSON: ناجح.
- Supabase CLI `2.117.0` اكتشف الأوامر وأنشأ migration الجديد.

Docker Desktop غير مثبت وPostgreSQL المحلي لـSupabase غير شغال على جهاز العمل؛ لذلك تعذر محليًا `docker compose` و`supabase migration list/advisors --local`. Workflow CI يبني الحاوية ويجري smoke test فعليًا بعد الرفع، بينما اختبارات PGlite طبقت كل migrations ونجحت.

GitHub Actions على commit التنفيذ `03280c6`: التشغيل `35284438985` مكتمل بنجاح؛ job `test` وjob `container` كلاهما ناجحان، بما في ذلك Compose validation وبناء الصورة وhealth/UI/config smoke tests. لم يعمل Workflow النشر لأن الفرع ليس `main`.

## قرارات ثابتة

- لا أسرار في المستودع أو صورة Docker. `.env.example` يحتوي قيمًا بديلة فقط.
- مفتاح Supabase القابل للنشر يمر من Caddy في `apikey`; لا يُرسل كمفتاح Bearer، ولا يصل `service_role` إلى المتصفح أو الحاوية.
- Caddy موجود للاستخدام الفعلي: static hosting، same-origin reverse proxy، رؤوس أمنية، وHTTPS تلقائي عند توفير نطاق.
- migrations السابقة لا تُعدّل. أي تحسين مخطط جديد additive وقابل للتراجع دون حذف بيانات.

## مخاطر/أعمال تشغيلية متبقية

- دخول العامل بالاسم والرقم الوظيفي ليس مصادقة قوية؛ يبقى الاعتماد النهائي بيد الأمين. يلزم قرار عمل منفصل لإضافة SSO/OTP.
- يلزم فحص بصري يدوي على شاشة المستودع والهاتف قبل أي نشر حي.
- يلزم تشغيل Supabase advisors واختبار staging الفعلي عند توفر بيانات اعتماد المشغل؛ لم تُستخدم بيانات اعتماد أو قاعدة حية في هذه المهمة.
- حماية كلمات المرور المسرّبة في Supabase كانت غير مفعلة حسب آخر فحص موثق، وتتطلب خطة مدفوعة؛ لم تُضف تكلفة.
- صفحات السجل والقوائم تستخدم `OFFSET` محدودًا؛ يكفي للحجم الحالي، ويُنقل إلى keyset pagination قبل نمو كبير.
