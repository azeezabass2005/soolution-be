import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import userRepository from "../src/repositories/user.repository";
import refreshTokenRepository from "../src/repositories/refresh-token.repository";
import transactionLimitLockRepository from "../src/repositories/transaction-limit-lock.repository";
import idempotencyKeyRepository from "../src/repositories/idempotency-key.repository";
import kycApplicationRepository from "../src/repositories/kyc-application.repository";
import partnerRepository from "../src/repositories/partner.repository";
import beneficiaryRepository from "../src/repositories/beneficiary.repository";
import postRepository from "../src/repositories/post.repository";
import transactionRepository from "../src/repositories/transaction.repository";
import BankAccountDetailsService from "../src/services/bank-account-details.service";
import UserService from "../src/services/user.service";
import IdempotencyService from "../src/services/idempotency.service";
import platformSettingsService from "../src/services/platform-settings.service";
import { isUniqueViolation } from "../src/db/errors";
import { addLegacyIdAliases } from "../src/utils/json.utils";

describe("repositories", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(resetTestDatabase);

    describe("users", () => {
        it("maps identity columns to user.identity and hides secrets unless asked", async () => {
            const user = await createUser({
                identityBvnHash: "hash-1",
                identityBvnLast4: "1234",
                identityBvnEnc: "enc",
                identityDob: "1990-01-01",
            });

            const plain = await userRepository.findById(user.id);
            expect(plain?.identity).toEqual({ status: "verified", bvnLast4: "1234", dob: "1990-01-01" });
            expect(plain?.password).toBeUndefined();
            expect(plain?.transactionPinHash).toBeUndefined();
            expect(plain).not.toHaveProperty("identityBvnHash");
            // NULL columns come back as missing fields, like Mongo
            expect(plain).not.toHaveProperty("kycRejectionReason");

            const secret = await userRepository.findById(user.id, { withSecrets: true });
            expect(secret?.identity.bvnHash).toBe("hash-1");
            expect(secret?.identity.bvnEnc).toBe("enc");
            expect(secret?.password).toBe("hashed");
        });

        it("updates identity conditionally and clears fields with null", async () => {
            const user = await createUser({ identityStatus: "pending", identityFailureReason: "old" });
            expect(await userRepository.updateIdentity(user.id, { status: "failed" }, { statusIs: "verified" })).toBe(false);
            expect(await userRepository.updateIdentity(user.id, { status: "verified", failureReason: null }, { statusIs: "pending" })).toBe(true);
            const updated = await userRepository.findById(user.id);
            expect(updated?.identity).toEqual({ status: "verified" });
        });

        it("allows one account per email (case-insensitive) and per BVN", async () => {
            await createUser({ email: "Same@Example.test", identityBvnHash: "bvn-x" });
            const service = new UserService();
            await expect(service.register({ email: "same@example.test", password: "x", firstName: "A", lastName: "B" })).rejects.toMatchObject({ response_code: 409 });
            expect((await service.findByEmail("SAME@example.TEST"))?.email).toBe("Same@Example.test");

            const other = await createUser();
            await expect(userRepository.updateIdentity(other.id, { bvnHash: "bvn-x" })).rejects.toSatisfy((error) => isUniqueViolation(error, "users_identity_bvn_hash_key"));
            expect(await userRepository.identityHashInUse("bvnHash", "bvn-x", other.id)).toBe(true);
        });

        it("records tier changes and only promotes upwards when asked", async () => {
            const user = await createUser({ tier: 0 });
            expect(await userRepository.setTier(user.id, 1, { reason: "BVN verified" }, { onlyIfBelow: true })).toBe(true);
            expect(await userRepository.setTier(user.id, 1, { reason: "again" }, { onlyIfBelow: true })).toBe(false);
            const history = await new UserService().tierHistory(user.id);
            expect(history.map((h) => h.reason)).toEqual(["BVN verified"]);
            expect((await userRepository.findById(user.id))?.tier).toBe(1);
        });

        it("computes the PIN-locked flag", async () => {
            const user = await createUser({ transactionPinLockedUntil: new Date(Date.now() + 60_000) });
            expect((await userRepository.findById(user.id))?.isTransactionPinLocked).toBe(true);
        });
    });

    it("spends a refresh token only once under concurrency", async () => {
        const user = await createUser();
        await refreshTokenRepository.create({ userId: user.id, token: "tok-1", expiresAt: new Date(Date.now() + 60_000) });
        const results = await Promise.all([refreshTokenRepository.consume("tok-1"), refreshTokenRepository.consume("tok-1")]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)?.isRevoked).toBe(false); // returned as it was before being spent
        expect((await refreshTokenRepository.findByToken("tok-1"))?.isRevoked).toBe(true);
    });

    it("gives the per-user limit lock to one holder, and takes it back after it expires", async () => {
        const results = await Promise.all([
            transactionLimitLockRepository.tryAcquire("user-1", "a", 60_000),
            transactionLimitLockRepository.tryAcquire("user-1", "b", 60_000),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);

        await transactionLimitLockRepository.release("user-1", "not-the-holder");
        expect(await transactionLimitLockRepository.tryAcquire("user-1", "c", 60_000)).toBe(false);

        await transactionLimitLockRepository.tryAcquire("user-2", "old", -1); // already expired
        expect(await transactionLimitLockRepository.tryAcquire("user-2", "new", 60_000)).toBe(true);
    });

    it("idempotency keys: one claim wins, repeats see its transaction", async () => {
        const user = await createUser();
        const service = new IdempotencyService();
        const claims = await Promise.allSettled([service.validateKey("k-1", user.id), service.validateKey("k-1", user.id)]);
        expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1);

        const tx = await transactionRepository.create({
            user: user.id, reference: "REF-IDEM", amount: 10, currency: "kes", fromCurrency: "ngn", detailType: "yellowcard",
        });
        expect(tx.currency).toBe("KES"); // uppercased like Mongoose did
        await service.updateKeyWithTransaction("k-1", tx.id);
        expect(await service.validateKey("k-1", user.id)).toEqual({ isDuplicate: true, transactionId: tx.id });
    });

    it("keeps a single default company bank account per currency", async () => {
        const banks = new BankAccountDetailsService();
        const first = await banks.createAccountDetails({ currency: "NGN", accountNumber: "1", accountName: "A", bankName: "Bank A" });
        const second = await banks.createAccountDetails({ currency: "NGN", accountNumber: "2", accountName: "B", bankName: "Bank B" });
        expect(first.isDefault).toBe(true);
        expect(second.isDefault).toBe(false);

        await banks.makeDefaultAccountDetails(second.id);
        expect((await banks.getCompanyDefault("NGN"))?.id).toBe(second.id);
        expect((await banks.getAccountDetails()).NGN.filter((a) => a.isDefault)).toHaveLength(1);
    });

    it("appends KYC history and archive without losing earlier entries", async () => {
        const user = await createUser();
        const app = await kycApplicationRepository.create({ user: user.id, type: "individual", tier: 2 });
        await kycApplicationRepository.update(app.id, { status: "submitted" }, { history: { status: "submitted", by: user.id, at: new Date() } });
        const updated = await kycApplicationRepository.update(app.id, { status: "approved", rejectionReason: null }, { history: { status: "approved", at: new Date() }, archive: { type: "individual" } });
        expect(updated?.history.map((h) => h.status)).toEqual(["submitted", "approved"]);
        expect(updated?.archive).toEqual([{ type: "individual" }]);
        expect(await kycApplicationRepository.countByStatus()).toEqual({ approved: 1 });
    });

    it("searches partners by name and role skills, literally (no wildcard injection)", async () => {
        await partnerRepository.create({ name: "Kemi Logistics", email: "KEMI@x.test", country: "NG", role: "LOGISTICS" });
        await partnerRepository.create({ name: "Tolu", email: "tolu@x.test", country: "NG", role: "SKILL", roleData: { skills: ["Plumbing", "Welding"] } });
        await partnerRepository.create({ name: "100% Real", email: "real@x.test", country: "GH", role: "TALENT", status: "active" });

        expect((await partnerRepository.paginate({}, {}, "weld")).data.map((p) => p.name)).toEqual(["Tolu"]);
        expect((await partnerRepository.paginate({}, {}, "%")).data.map((p) => p.name)).toEqual(["100% Real"]);
        expect((await partnerRepository.paginate({ country: "NG" }, {})).paginator.itemsCount).toBe(2);
        const active = (await partnerRepository.paginate({ status: "active" }, {})).data[0];
        expect(active.email).toBe("real@x.test");
        expect(active.lastActiveAt).toBeInstanceOf(Date);
    });

    it("orders beneficiaries by last use, never-used last", async () => {
        const user = await createUser();
        const a = await beneficiaryRepository.create({ user: user.id, currency: "KES", kind: "momo", momoName: "A" });
        const b = await beneficiaryRepository.create({ user: user.id, currency: "KES", kind: "momo", momoName: "B" });
        await beneficiaryRepository.touchLastUsed(a.id);
        expect((await beneficiaryRepository.listForUser(user.id)).map((x) => x.id)).toEqual([a.id, b.id]);
    });

    it("finds related posts by text and shared tags", async () => {
        const author = await createUser();
        const other = await createUser();
        const post = await (await import("../src/db/client")).getDb().insert((await import("../src/db/schema")).posts).values([
            { title: "Sending money to Ghana", content: "How to send cedis to Ghana quickly with mobile money", category: "guides", tags: ["ghana", "momo"], user: author.id },
            { title: "Ghana mobile money limits", content: "Limits for mobile money transfers in Ghana", category: "guides", tags: ["ghana"], user: other.id },
            { title: "Cooking jollof", content: "A recipe", category: "food", tags: [], user: other.id },
        ]).returning();
        const related = await postRepository.findRelated(post[0] as any, {
            limit: 5, includeSameUser: false, weights: { category: 3, tag: 2, text: 1.5, engagement: 1, timeDecay: 0.5 },
        });
        expect(related.map((r) => r.title)).toEqual(["Ghana mobile money limits"]);
        expect(related[0].scores.tags).toBe(2);
        expect(typeof related[0].user === "object" && related[0].user.id).toBe(other.id);
    });

    it("seeds platform settings once and keeps nested shapes", async () => {
        const settings = await platformSettingsService.getSettings();
        expect(settings.providerBaseFeePercent).toEqual({ ogateway: 1.5, yellowcard: 0 });
        expect(settings.tierDailyLimitUsd).toEqual({ tier1: 2000, tier2: 100000 });
        const user = await createUser();
        const updated = await platformSettingsService.updateSettings({ rateMarkupPercent: 2, providerBaseFeePercent: { yellowcard: 1 } }, user.id);
        expect(updated.rateMarkupPercent).toBe(2);
        expect(updated.providerBaseFeePercent).toEqual({ ogateway: 1.5, yellowcard: 1 });
    });

    it("adds an _id alias to every record in API responses", () => {
        const id = "6f1c2a9e-1d2b-4c3d-8e4f-5a6b7c8d9e0f";
        const json = JSON.parse(JSON.stringify({ data: [{ id, nested: { id } }], other: { id: "not-a-uuid" } }, addLegacyIdAliases));
        expect(json.data[0]._id).toBe(id);
        expect(json.data[0].nested._id).toBe(id);
        expect(json.other._id).toBeUndefined();
    });
});
