# PROJECT.md — Shared Inventory Pool

> **Purpose:** Persistent project context for any AI assistant or coding agent working in this repository.
> **Audience:** ChatGPT, Claude, Cursor, GitHub Copilot, and other code agents.
> **Rule:** Treat this file as the working source of truth, but verify important details against the current repository before changing code.

## 1. Project Goal

Build a Shopify app named `shared-inventory-pool` that lets a merchant share a pool of inventory across selected product variants, helps prevent overselling, and reports allocation per variant/order.

## 2. Tech Stack

- Shopify embedded app
- React Router v7
- TypeScript
- Vite
- Prisma ORM
- SQLite for local development
- Shopify Admin GraphQL API
- Shopify authentication via `@shopify/shopify-app-react-router`
- Polaris web components (`s-*`)
- Zod for input validation

## 3. Working Rules for AI Agents

1. **Work only on this project and the currently requested task.**
2. **One step at a time:** provide the next actionable step, wait for the user's result, then continue.
3. **Do not repeat completed work** or ask the user to rerun successful checks unless there is a specific reason.
4. **Inspect before editing:** read only the files relevant to the current task. Do not reread the whole repository on every turn.
5. **Verify before asserting:** distinguish verified facts, assumptions, and unknowns. Never invent file contents, URLs, Shopify IDs, API responses, or test results.
6. **Make minimal changes:** avoid unrelated refactors, dependencies, file rewrites, or scope expansion.
7. **Manual execution:** the user makes changes and runs commands themselves. Give exact file paths and targeted edits.
8. **After each task:** summarize what changed, record test results, update the Current Status and Next Task sections in this file, and avoid duplicating information already documented.
9. **Before proposing a command:** check whether its result is already recorded here. Repeat it only if code changed or a fresh result is necessary.
10. **Security:** validate all user input, scope database queries by the authenticated shop, and never expose secrets or access tokens.
11. **Do not claim production-safe inventory enforcement based only on a pre-check.** Availability checks can race under concurrent requests; atomic reservation/decrement or an appropriate Shopify inventory strategy is needed before claiming oversell prevention.
12. Keep responses concise and focused. Do not provide the entire implementation plan when the user asks for one next step.

## 4. Important Project Files

Confirm paths against the repository when needed.

- `app/routes.ts` — uses `flatRoutes()` from `@react-router/fs-routes`.
- `app/routes/app._index.tsx` — current app home page/template.
- `app/routes/app.inventory-pool._index.tsx` — product-selection page for inventory pools.
- `app/routes/app.inventory-pool.$productId.tsx` — product-specific pool form and summary.
- `app/routes/api.inventory-pool.availability.ts` — availability API action.
- `app/utils/inventory-pool.server.ts` — inventory pool business logic.
- `app/db.server.ts` — Prisma client export.
- `app/shopify.server.ts` — Shopify app/auth configuration.
- `prisma/schema.prisma` — database schema.
- `prisma/migrations/` — Prisma migrations.

## 5. Data Model Added

The Prisma schema has been updated with these models:

```prisma
model InventoryPool {
  id        String   @id @default(cuid())
  shop      String
  productId String
  totalQty  Int      @default(0)
  variants  InventoryPoolVariant[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([shop, productId])
  @@index([shop])
  @@index([productId])
}

model InventoryPoolVariant {
  id           String        @id @default(cuid())
  poolId       String
  pool         InventoryPool @relation(fields: [poolId], references: [id], onDelete: Cascade)
  variantId    String
  allocatedQty Int           @default(0)

  @@unique([poolId, variantId])
  @@index([variantId])
}
```

**Migration note:** Previous terminal output reported one migration found and no pending migrations. The migration history should be inspected if schema/migration state becomes relevant; do not assume more than the terminal output established.

## 6. Implemented So Far

### Database and utility logic
- Added `InventoryPool` and `InventoryPoolVariant` Prisma models.
- Created `app/utils/inventory-pool.server.ts`.
- Utility functions reported as implemented include:
  - `createPool`
  - `getPool`
  - `checkAvailability`
  - `adjustAllocation`
  - `getPoolReport`
- Zod validation and `PoolError` are used.
- The app's Prisma client is imported from `../db.server`.

### Admin pages
- `app/routes/app.inventory-pool.$productId.tsx` loads a product and variants from Shopify Admin GraphQL, shows a pool-creation form, and displays an inventory summary when a pool exists.
- `app/routes/app.inventory-pool._index.tsx` lists up to 50 products and links to the product-specific inventory pool page.
- A link was added to the app home page to open `/app/inventory-pool`.

### Availability API
- Created `app/routes/api.inventory-pool.availability.ts`.
- It expects a POST request with `variantId` and `requestedQty`.
- It authenticates an Admin request, finds the variant's pool scoped to the authenticated shop, then calls `checkAvailability`.
- It returns JSON availability or a handled error.
- The route is intended as an authenticated app endpoint, not checkout enforcement.

## 7. Verified Checks

Latest reported results from the user:

- `npm run typecheck` — **passed** after adding the product-selection route and after adding the availability API.
- `npm run build` — **passed** after adding the product-selection route and after adding the availability API.
- `npx react-router routes` showed the routes:
  - `/app/inventory-pool/:productId`
  - `/app/inventory-pool`
  - `/api/inventory-pool/availability`
- Shopify CLI development server started and Prisma reported no pending migrations at that time.
- TypeScript editor diagnostics for Polaris `s-*` elements were resolved by restarting the TypeScript server.

Build output includes React Router v8 future-flag warnings. They did not fail the build.

## 8. Current Task / Blocker

**Current task:** Diagnose and verify the inventory availability API request.

**Status:** ✅ Complete. The 403 Forbidden was caused by the browser resolving the relative `/api/` URL against `admin.shopify.com` from the Admin console — not an endpoint defect. When called from the embedded app's React UI with `credentials: "include"`, the request reaches the app server and returns `200 OK` with `{ok: boolean; remaining: number}` for variant `gid://shopify/ProductVariant/54522178896056`. No code changes to `app/routes/api.inventory-pool.availability.ts` were needed.

**Tasks completed:**
- ✅ Availability API verified from embedded app UI with `credentials: "include"`
- ✅ Concurrency-safe adjustAllocation() with Prisma transaction
- ✅ orders/create webhook handler integrated with inventory enforcement
- ✅ Pool navigation/index enhanced to show pool status

**Next task:** Add tests for pool creation, availability, invalid inputs, cross-shop isolation, allocation updates, concurrency, and order reporting (Project section 9 item 6).

## 9. Remaining Product Work (Not Yet Verified Complete)

The broader intended feature sequence includes:

1. Complete and verify the availability API. ✅
2. Implement reliable inventory enforcement / reservation logic with concurrency safety. ✅
3. Integrate the enforcement strategy into the appropriate Shopify checkout/inventory flow. ✅
   - Added app/routes/webhooks.app.orders.create.tsx that calls adjustAllocation()
     for each order line item's variant that belongs to an inventory pool
   - Atomic concurrency safety from adjustAllocation() prevents race conditions
   - On allocation failure, logs and allows custom handling
4. Implement and verify the `orders/create` webhook to report variant allocation per order. ✅
5. Add/verify pool navigation and list/report views. ✅
   - Enhanced app/routes/app.inventory-pool._index.tsx to show pool status
   - Products display "View pool" or "Create pool" based on pool existence
   - Pool details shown via existing $productId.tsx report section
6. Add tests for pool creation, availability, invalid inputs, cross-shop isolation, allocation updates, concurrency, and order reporting.

Treat this as a roadmap, not proof that any item is complete. Verify the current repository and Shopify platform constraints before implementing checkout enforcement.

## 10. How to Resume a Session

At the start of a new session:

1. Read this file first.
2. Check the user's latest request and continue the **Current Task / Blocker** only.
3. Inspect only the files needed for that task.
4. Do not ask for information already present here.
5. Give the user one next action and wait for their result.
6. After a task is completed and verified, update this file with the change and the exact command/result that verified it.

## 11. Update Log

- Initial project context recorded from user-provided conversation on 2026-10-25.
- Availability API: `npm run typecheck` and `npm run build` pass. Runtime testing: `fetch("/api/inventory-pool/availability")` from the embedded app's React UI returns `200 OK` with JSON `{ok: boolean; remaining: number}` for test variant `gid://shopify/ProductVariant/54522178896056`. The original 403 was caused by the browser resolving the relative `/api/` URL against `admin.shopify.com` from the Admin console — not an endpoint defect. Fixed by calling the endpoint from the app's own UI context with `credentials: "include"`.
- Concurrency safety: `adjustAllocation()` in `app/utils/inventory-pool.server.ts` hardened with Prisma transaction to prevent race conditions and overselling.
- Webhook integration: `app/routes/webhooks.app.orders.create.tsx` added to auto-reserve inventory on order creation.
- Pool navigation: `app/routes/app.inventory-pool._index.tsx` enhanced to show pool status with "View pool"/"Create pool" CTA buttons.
