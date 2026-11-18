import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import identityService, { joinAddress, parseAddressParts } from "../src/services/identity.service";
import userRepository from "../src/repositories/user.repository";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { createUser } from "./helpers/fixtures";

const address = { street: "12 Allen Avenue", city: "Ikeja", state: "Lagos", lga: "Ikeja", country: "NG" };
const selfie = [{ image: "abc", image_type_id: 2 }];

describe("identity details before the selfie", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(resetTestDatabase);

    it("checks the address fields, with an LGA only in Nigeria", () => {
        expect(parseAddressParts(address).parts).toEqual(address);
        expect(joinAddress(parseAddressParts(address).parts!)).toBe("12 Allen Avenue, Ikeja, Ikeja LGA, Lagos, NG");
        expect(parseAddressParts({ ...address, lga: "" }).problem).toEqual({ field: "lga", message: "Choose your LGA" });
        expect(parseAddressParts({ ...address, street: "1" }).problem?.field).toBe("street");
        const ghana = parseAddressParts({ street: "5 Oxford Street", city: "Osu", state: "Greater Accra", country: "GH" });
        expect(ghana.parts).toEqual({ street: "5 Oxford Street", city: "Osu", state: "Greater Accra", country: "GH" });
    });

    it("needs a date of birth, an address and a proof of address before checking", async () => {
        const user = await createUser({ tier: 0, identityStatus: "unverified" } as any);
        const submit = (personal: any) => identityService.submitBvn(user, "22222222222", selfie, "33333333333", personal);
        await expect(submit({ dob: "", address })).rejects.toMatchObject({ response_code: 400, message: "Enter your date of birth" });
        await expect(submit({ dob: "2015-01-01", address })).rejects.toMatchObject({ message: "You must be at least 18 to use Solution Pay" });
        await expect(submit({ dob: "1990-05-01", address: { ...address, city: "" } })).rejects.toMatchObject({ message: "Enter your city or town" });
        await expect(submit({ dob: "1990-05-01", address })).rejects.toMatchObject({ message: "Upload a proof of address" });

        // With a proof of address on file, the details are accepted (the selfie check is next)
        await userRepository.updateIdentity(user.id, { proofOfAddress: { key: "k", name: "bill.pdf", mimeType: "application/pdf", size: 10, uploadedAt: new Date().toISOString() } });
        const summary = await identityService.adminSummary(user.id);
        expect(summary.details?.proofOfAddress).toMatchObject({ name: "bill.pdf" });
    });
});
