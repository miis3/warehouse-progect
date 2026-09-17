# warehouse-progect

## Warehouse management candidate

The management system lives on `feature/warehouse-management`; the live Pages deployment is unchanged.
See [Arabic setup, features and verification report](docs/warehouse-management.md) and [inventory review](docs/inventory-review.md).

```sh
npm ci --ignore-scripts
npm run check
npm test
python -m http.server 8000 --directory warehouse-project/site/dist
```

Open http://localhost:8000/ to test against the isolated Supabase staging project. Local manual actions persist to staging; automated tests use an isolated temporary database.
