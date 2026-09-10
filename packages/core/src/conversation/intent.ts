export type Intent = "MENU" | "HELP" | "BACK" | "CANCEL" | "SUPPORT" | "YES" | "NO" | "REGISTER" | "ENTER" | "MECHANICS" | "TERMS" | "PRIZES" | "WINNERS" | "STATUS" | "GREETING" | "NUMBER" | "TEXT" | "IMAGE" | "UNSUPPORTED";
const WORDS: Array<[Intent, string[]]> = [
  ["MENU", ["menu", "main menu", "home", "start", "0"]], ["HELP", ["help", "9", "?"]], ["BACK", ["back", "b"]], ["CANCEL", ["cancel", "stop", "exit", "quit"]], ["SUPPORT", ["support", "agent", "human", "help me", "talk to someone"]],
  ["YES", ["yes", "y", "accept", "agree", "confirm", "ok", "okay", "yebo"]], ["NO", ["no", "n", "decline", "reject"]],
  ["REGISTER", ["1", "register", "sign up", "signup"]], ["ENTER", ["2", "enter", "enter promotion", "enter the promotion", "submit receipt"]], ["MECHANICS", ["3", "how it works", "mechanics", "how"]], ["TERMS", ["4", "terms", "t&c", "t&cs", "terms and conditions"]],
  ["PRIZES", ["5", "prizes", "prize"]], ["WINNERS", ["6", "winners", "winner"]], ["STATUS", ["7", "status", "my entries", "entries"]],
  ["GREETING", ["hi", "hello", "hey", "hie", "hallo", "good morning", "good afternoon", "good evening", "morning", "mhoro", "salibonani"]],
];
/** Deterministic intent parsing; numeric replies are carried separately so list states can consume them before menu keys apply. */
export function parseIntent(text: string | null | undefined, kind: "text" | "image" | "unsupported" = "text"): { intent: Intent; number: number | null; text: string } {
  if (kind === "image") return { intent: "IMAGE", number: null, text: "" };
  if (kind === "unsupported") return { intent: "UNSUPPORTED", number: null, text: "" };
  const t = String(text ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  const number = /^\d{1,2}$/.test(t) ? Number(t) : null;
  for (const [intent, words] of WORDS) if (words.includes(t)) return { intent, number, text: t };
  if (number != null) return { intent: "NUMBER", number, text: t };
  return { intent: "TEXT", number: null, text: String(text ?? "").trim() };
}
