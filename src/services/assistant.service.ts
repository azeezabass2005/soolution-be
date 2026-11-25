import { HELP_ARTICLES, STOP_WORDS, SYNONYMS, type HelpArticle } from "../common/help-articles";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";

const MAX_QUESTION = 500;
/** Below this the best match isn't trusted, and the assistant offers a person instead */
const CONFIDENT = 2;

/** Lower-case words, synonyms folded in, filler dropped */
export const wordsOf = (text: string): string[] => {
    const raw = String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
    // Plurals count as the word ("links" is "link"), then synonyms fold in
    const single = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
    return raw.map((w) => SYNONYMS[w] ?? SYNONYMS[single(w)] ?? single(w)).flatMap((w) => w.split(" ")).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
};

/** Words that appear in almost every question: alone they barely say what it's about */
const GENERIC = new Set(["pay", "money", "naira", "account", "wallet"]);

/**
 * How well an article fits: a keyword phrase found whole in the question
 * counts most (longer phrases more), single shared words and title words less.
 */
const score = (article: HelpArticle, question: string, words: Set<string>) => {
    const text = ` ${wordsOf(question).join(" ")} `;
    let total = 0;
    for (const keyword of article.keywords) {
        const k = wordsOf(keyword).join(" ");
        if (!k) continue;
        if (text.includes(` ${k} `)) total += GENERIC.has(k) ? 0.75 : 2 + (k.split(" ").length - 1);
        else if (k.split(" ").every((w) => words.has(w))) total += 1.5;
        else if (k.split(" ").some((w) => words.has(w) && w.length > 3)) total += 0.5;
    }
    for (const w of wordsOf(article.title)) if (words.has(w)) total += 0.5;
    return total;
};

/**
 * The support assistant: answers from our help articles straight away, free
 * and in-house. When it isn't confident it says so, and the user can talk
 * to a person (a Support conversation our team sees).
 */
class AssistantService {
    answer(rawQuestion: unknown) {
        const question = typeof rawQuestion === "string" ? rawQuestion.trim().slice(0, MAX_QUESTION) : "";
        if (question.length < 2) throw errorResponseMessage.createError(400, "Ask a question", ErrorSeverity.LOW);
        const words = new Set(wordsOf(question));
        const ranked = HELP_ARTICLES
            .map((article) => ({ article, score: score(article, question, words) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score);
        const best = ranked[0];
        const confident = !!best && best.score >= CONFIDENT;
        const answers = (confident ? ranked.filter((r) => r.score >= Math.max(CONFIDENT, best.score * 0.6)) : ranked).slice(0, confident ? 2 : 3);
        return {
            confident,
            answers: answers.map(({ article }) => ({ id: article.id, title: article.title, answer: article.answer, link: article.link ?? null })),
        };
    }

    /** A few starting points for the chat */
    suggestions() {
        return ["fund-wallet", "send-money", "receive-money", "pending", "failed-refund", "verification"]
            .map((id) => HELP_ARTICLES.find((a) => a.id === id)!)
            .map((a) => ({ id: a.id, title: a.title }));
    }

    byId(id: string) {
        const a = HELP_ARTICLES.find((x) => x.id === id);
        if (!a) throw errorResponseMessage.resourceNotFound("Help article");
        return { id: a.id, title: a.title, answer: a.answer, link: a.link ?? null };
    }
}

export default new AssistantService();
