# Warehouse management

نظام إدارة مستودع عربي RTL يحافظ على الخريطة والصناديق والصور والبحث والباركود، مع Supabase/PostgreSQL وEdge Function محمية. النسخة الحالية جاهزة للتشغيل المحلي/الذاتي عبر Docker على Windows؛ لم يتغير `main` أو الموقع الحي.

## تشغيل Windows

```powershell
Copy-Item .env.example .env
notepad .env
docker compose up --detach --build --wait
Start-Process http://localhost:8080
```

ضع في `.env` رابط Supabase وpublishable key فقط. **لا تضع `service_role` أو secret key.** للتفاصيل وHTTPS والإيقاف راجع [DEPLOYMENT.md](DEPLOYMENT.md).

## نسخة اختبار محلية كاملة

لتجربة العامل والأمين والاستلام والإرجاع دون Docker أو بيانات حقيقية:

```powershell
npm ci --ignore-scripts
npm run preview:test
```

افتح `http://127.0.0.1:8000`. حساب الإدارة المحلي: `preview-admin` وكلمة المرور `Warehouse-Preview-2026!`. ابحث بحساب العامل عن `منشار`. تتلف كل بيانات التجربة عند إيقاف الخادم.

## التحقق

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

ابدأ من [PROJECT_STATE.md](PROJECT_STATE.md) للحالة الحالية، و[ARCHITECTURE.md](ARCHITECTURE.md) للبنية، و[SECURITY.md](SECURITY.md) للمراجعة الأمنية. تعليمات المساهمة الإلزامية في [AGENTS.md](AGENTS.md)، وتفاصيل المخزون في [docs/inventory-review.md](docs/inventory-review.md).
