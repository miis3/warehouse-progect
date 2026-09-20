# Database

## المصدر والنطاق

قاعدة البيانات PostgreSQL على Supabase. المخطط التشغيلي `warehouse` خاص وغير معروض مباشرة للمتصفح. لا تُستخدم جداول `public`؛ توجد في `public` دوال RPC محددة فقط لاستدعاء Edge Function.

المخطط يتكون من:

- المواقع والصناديق والمعدات والقطع: `locations`, `boxes`, `items`, `units`.
- الهوية التشغيلية: `workers`, `staff_accounts`, `sessions`, `setup_tokens`.
- سير العمل: `requests`, `loans`.
- إعداد التأخير: `settings` (سجل singleton، `overdue_days` اختياري حتى يحدده المدير، وFK للمعدّل).
- الصيانة: `maintenance_tickets` مع FKs للقطعة والعهدة والعامل والطلب ومن فتح/أغلق البلاغ. قيد فريد لبلاغ واحد مفتوح لكل قطعة، وتاريخ غير قابل للمحو أو إعادة الكتابة.
- الحماية والرصد: `rate_limits`, `audit_events`.

## تاريخ migrations

- `20260917162751_warehouse_core.sql`: المخطط، RPC، الصلاحيات، RLS، المعاملات، السجل.
- `20260917163408_warehouse_inventory.sql`: استيراد additive وحتمي للمخزون المصدر.
- `20260917164027_warehouse_staff_and_indexes.sql`: إدارة الموظفين والفهارس وسياسات deny-all.
- `20260917174734_warehouse_staff_serialization.sql`: تسلسل تغييرات الموظفين لمنع السباقات.
- `20260917182804_warehouse_production_indexes.sql`: فهارس additive للـFK التاريخي والجلسات وتنظيف rate limits.
- `20260920032912_warehouse_workflows.sql`: الإعدادات وبلاغات الصيانة و`requests.return_checkout_request_id` وحقول استبعاد القطع وRPC المعاملات الجديدة وفهارسها وRLS.

طبقت ملفات الفهارس وسير العمل على مشروع staging المتصل في 2026-09-20. أداة التطبيق أعطت معرفي وقت `20260920034950` و`20260920034952`؛ بعد نجاح التطبيق طُوبقت سجلات migration metadata مع معرفي الملفات الأصلية `20260917182804` و`20260920032912`، دون تغيير SQL أو إعادة تطبيقه أو تغيير بيانات المخزون. إصدارات remote/local متطابقة.

ينقل التحديث RPC السابق إلى `warehouse.warehouse_api_core` الخاص ويمنع استدعاءه مباشرة حتى بـservice_role. واجهة `public.warehouse_api` الجديدة تعيد استعماله حيث يلزم، وتنفذ الاعتماد والصندوق والصيانة ضمن معاملة واحدة. لا تُعدّل migrations الأقدم.

الاسم التقني القديم `items.inventory_reviewed` باقٍ للتوافق، ويعني اكتمال البيانات الأولية مرة واحدة لا مراجعة دورية. إضافة المعدة تنشئ قطعها ذريًا؛ تعديل صنف قديم غير مكتمل مع `initialize_stock:true` يسجل العدد والحالة مرة واحدة. بيانات الكشف المصدرية لا تتغير.

الصندوق: `requests.box_id` يحدد طلب الصرف الأصلي و`snapshot` يحفظ محتوياته وقت الطلب/الصرف، وكل `loan` يرتبط بطلب الصرف. إرجاع الصندوق يجمع العهد المفتوحة لذلك الطلب فقط، لا محتويات الصندوق الحالية. الإضافات اللاحقة أو تغيير الاسم لا تغيّر تاريخ العهدة. ترقيم الصفحات يقع على مجموعات العهد لا على قطع الصندوق.

التأخير يُحسب من وقت الصرف وفق إعداد المدير الحالي؛ لا وظيفة تحذف أو تغلق العهدة. الطلب مسموح حتى مع التأخير، لكن الاعتماد يعيد فحصه ويلزم `acknowledge_overdue:true` عند وجوده. الإعدادات والسجل وإغلاق الصيانة تعود إلى صلاحيات الخادم لا عناصر الواجهة.

الاستبعاد soft-retirement عبر `units.retired_at/retired_by/retirement_note`؛ يُمنع مع عهدة أو طلب أو بلاغ مفتوح. لا destructive migrations أو محو بيانات. عدد القطع المستوردة بقي صفرًا عن قصد؛ لم تُفترض حالات سليمة.

لا تعدّل ملف migration مطبقًا. أنشئ migration جديدًا عبر `supabase migration new <name>`، واختبره محليًا، ثم شغّل advisors وراجع diff قبل ربط أي مشروع بعيد.

## نموذج الصلاحيات

- RLS مفعّل على كل جدول في `warehouse`.
- الصلاحيات المباشرة مسحوبة من `public`, `anon`, `authenticated`, و`service_role`.
- سياسات `no_direct_access` تمنع browser roles دفاعيًا.
- تنفيذ RPC مسموح فقط لـ`service_role`; الدوال `SECURITY DEFINER` تضبط `search_path=warehouse,pg_temp`.
- Edge Function تحتفظ بالمفتاح ذي الامتياز وتطبق session/role/ownership checks قبل RPC.
- لا تعتمد الصلاحيات على `user_metadata` أو قيم يرسلها العميل.

## الاتساق والسباقات

- الطلب له `client_key` فريد لكل عامل ليدعم retry idempotency.
- الاعتماد يقفل الصناديق والقطع بترتيب ثابت داخل معاملة.
- partial unique index يمنع عهدتين نشطتين للقطعة نفسها.
- advisory transaction locks تسلسل التسجيل والطلبات وتغييرات الموظفين.
- فحص الصندوق الكامل يقارن مجموعة القطع وقت الاعتماد لمنع stale approval.

## Audit log

- `audit_events` append-only؛ triggers تمنع `UPDATE`, `DELETE`, و`TRUNCATE`.
- تاريخ الخروج في `loans` ثابت، ولا يسمح التعديل إلا بإكمال حقول الإرجاع مرة واحدة.
- عمليات الإدارة والمخزون والعهد تسجل snapshot قديمًا وجديدًا وهوية المنفذ.
- مالك قاعدة البيانات/تغيير DDL خارج نموذج ضمان التطبيق؛ يلزم تقييد حسابات Dashboard وتسجيل تغييرات الإدارة تشغيليًا.

## أوامر تحقق آمنة

```powershell
npm run test:database
npm test
npx supabase migration list --local
npx supabase db advisors --local
```

الأمران الأخيران يحتاجان Supabase CLI وDocker محليًا. لا تستخدم `db reset`, `migration down`, أو أوامر remote دون نسخة احتياطية وتفويض صريح.
