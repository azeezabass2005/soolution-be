/**
 * Compares the name on an account with the name an ID authority returns.
 * ID records often carry middle names and different ordering, so the account's
 * first and last names must each appear among the ID's name parts (in any
 * order); spacing, case, accents and punctuation are ignored.
 */

const tokens = (value?: string | null): string[] =>
    (value || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z\s-]/g, " ")
        .split(/[\s-]+/)
        .filter((part) => part.length > 1);

export interface NameOnId {
    fullName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    otherNames?: string | null;
}

export type NameMatch =
    | { match: true; nameOnId: string }
    | { match: false; nameOnId: string }
    | { match: null; nameOnId: null };

/** null `match` means the ID returned no name to compare */
export const matchNameOnId = (account: { firstName?: string; lastName?: string }, id: NameOnId): NameMatch => {
    const nameOnId = [id.fullName, [id.firstName, id.otherNames, id.lastName].filter(Boolean).join(" ")]
        .map((name) => (name || "").replace(/\s+/g, " ").trim())
        .find((name) => name.length > 0);
    if (!nameOnId) return { match: null, nameOnId: null };

    const idParts = new Set(tokens([id.fullName, id.firstName, id.otherNames, id.lastName].filter(Boolean).join(" ")));
    const first = tokens(account.firstName);
    const last = tokens(account.lastName);
    if (!first.length || !last.length) return { match: false, nameOnId };

    const contains = (parts: string[]) => parts.every((part) => idParts.has(part));
    return { match: contains(first) && contains(last), nameOnId };
};
