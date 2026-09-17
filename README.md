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

## التحقق

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

ابدأ من [PROJECT_STATE.md](PROJECT_STATE.md) للحالة الحالية، و[ARCHITECTURE.md](ARCHITECTURE.md) للبنية، و[SECURITY.md](SECURITY.md) للمراجعة الأمنية. تعليمات المساهمة الإلزامية في [AGENTS.md](AGENTS.md)، وتفاصيل المخزون في [docs/inventory-review.md](docs/inventory-review.md).
