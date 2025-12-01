<!-- Copilot / AI agent instructions for the Solution Pay backend -->
# Solution Pay — Copilot instructions

Purpose: give AI coding agents the precise context and conventions they need to be immediately productive in this repository.

- Language & runtime: TypeScript (v5), Node.js, Express. Code is compiled with `tsc` to `dist/` and run from `dist/index.js`.
- Entry points: `src/index.ts` and `src/app.ts`. The compiled entry is `dist/index.js` (see `package.json` `main`).

Big-picture architecture (how things flow)
- HTTP request -> `src/routes/*` -> `Controller` in `src/controllers/*` -> `Service` in `src/services/*` -> `Model` in `src/models/*` (Mongoose) -> utils/config.
- Controllers extend `BaseController` (see `src/controllers/base/base-controller.ts`) and set up routes on `this.router`. Use the `bind(this)` pattern when passing controller methods as handlers.
- Protected vs public controllers: controllers are organized under `src/controllers/base/protected` and `.../public`. Protected controllers commonly use `RoleMiddleware` or `auth.middleware` to guard endpoints.

Key patterns & conventions (project-specific)
- Controllers: set up routes in `setupRoutes()`; example pattern: in `src/controllers/base/protected/dashboard.controller.ts`
  - this.router.get("/dashboard", RoleMiddleware.isAdmin, this.getDashboardData.bind(this));
  - Keep controller methods focused on orchestration; delegate business logic to services.
- Services: single-responsibility classes or modules in `src/services/*`. Prefer adding DB queries and aggregation pipelines here rather than glueing logic in controllers.
- Models: Mongoose model files end with `.model.ts` and live in `src/models/`.
- Validation: Zod schemas live in `src/validators` (files named `z-*.ts`) and are applied via `validation.middleware.ts`.
- Errors: use the centralized error middleware `src/middlewares/error.middleware.ts` and the `app-error.utils.ts` helpers in `src/utils/` for consistent error shapes.
- File uploads: uses `multer` with `src/middlewares/multer.middleware.ts` and upload config in `src/config/upload.config.ts` and `src/services/file-upload.service.ts`.
- Response handling: controllers often use a base response handler (`src/controllers/base/base-response-handler.ts`) — follow its conventions for success/error payload shapes.

Build, dev & run commands (as discovered)
- npm run build -> `tsc` (produces `dist/`)
- npm run dev -> `npx tsc && node ./dist/index.js` (project does not currently use `ts-node-dev` in `dev` script)
- npm start -> `node dist/index.js`

Notable integrations & dependencies
- Persistence: `mongoose` (MongoDB). Models are in `src/models/`.
- Cloud & storage: AWS S3 SDK (`@aws-sdk/*`) and a `r2.config.ts` exists (Cloudflare R2/Worker integration hinted by `wrangler` in devDependencies).
- Identity / 3rd-party: Smile Identity (`smile-identity-core`) and `whatsapp-web.js` are used in services for onboarding/notifications.
- Logging: `winston` + `winston-daily-rotate-file`.

Where to make common changes
- New route: add a controller under `src/controllers/*`, register routes in `src/routes/public/index.ts` or `src/routes/protected/index.ts` depending on exposure, and then add service logic in `src/services/*`.
- New DB queries: add to a service; if complex, add aggregation pipelines in service files and keep controllers thin.
- New validation: create a `z-*.ts` schema in `src/validators` and wire it into the route using `validation.middleware.ts`.

Examples (concrete)
- Protect an admin-only route: `this.router.get('/x', RoleMiddleware.isAdmin, this.method.bind(this))` (see `src/controllers/base/protected/dashboard.controller.ts`).
- Use a service from a controller:
  - const data = await this.someService.getSomething(params);
  - return BaseResponseHandler.success(res, data);

What NOT to change lightly
- Do not hardcode environment secrets — use `src/config/env.config.ts`.
- Avoid changing the runtime/tsconfig targets without running a build locally; behavior depends on compiled output under `dist/`.

Missing or limited areas (discoverable gaps)
- There are no automated tests configured (package.json `test` is a placeholder). If you add tests, follow the project's module boundaries (test services and controllers separately).

If you're unsure, follow these quick checks
1. Find the controller for the route in `src/controllers/` and mirror its style when adding new controllers.
2. Put business logic into `src/services/` and DB models to `src/models/`.
3. Use `validation.middleware.ts` + `src/validators/z-*.ts` for input validation.

If anything here is unclear or you want this adapted (e.g., stricter testing guidance, CI hooks, or examples of aggregation pipelines), tell me which sections to expand and I will iterate.
