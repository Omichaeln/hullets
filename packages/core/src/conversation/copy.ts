/**
 * Participant-facing copy. Every message is a content key with data-driven
 * variables; a campaign version's content.messages overrides any key. Rules:
 * confirmations never imply a win, duplicate notices never name the other
 * submitter, rejections use approved reason codes, everything renders as
 * plain text on a phone.
 */
export const MESSAGES: Record<string, string> = {
  menu: "Welcome to {campaign}!\n1. Register\n2. Enter the promotion\n3. How it works\n4. Terms & conditions\n5. Prizes\n6. Winners{status_item}\n9. Help\n\nReply with a number.",
  menu_status_item: "\n7. My entries",
  no_campaign: "There is no promotion running at the moment. Please check back soon.",
  closed: "This promotion has closed. Thank you for taking part! Reply 6 to see the winners.",
  paused: "Entries are paused for a short while. Please try again later. Reply MENU for the other options.",
  unknown: "Sorry, I didn't understand that.\n\n{menu}",
  help: "Help: reply 1 to register, 2 to enter, 3 for how it works, 4 for the terms, 5 for prizes, 6 for winners, 9 for help. MENU returns to the start, BACK goes one step back, CANCEL stops what you are doing. Reply SUPPORT to talk to a person.",
  cancel: "Cancelled. Reply MENU to start again.",
  need_photo: "Please send a PHOTO of your receipt (camera or gallery). Voice notes, stickers and text cannot be checked. Reply MENU to go back.",
  media_missing: "We couldn't download that image. Please send the photo again.",
  media_rejected: "That file couldn't be used ({reason}). Please send a clear JPEG or PNG photo of the receipt.",
  not_registered: "You need to register first — it takes a minute. Reply 1 to register.",
  reg_first: "Let's get you registered. What is your FIRST NAME?",
  reg_surname: "Thanks {first_name}. What is your SURNAME?",
  reg_identity: "What is your national ID number? Letters and numbers only. It stays private and is used only to verify winners.",
  reg_identity_retry: "That doesn't look like an ID number. Reply with letters and numbers only (5–20 characters), or CANCEL.",
  reg_location: "Which town or city do you live in?",
  reg_retry: "Please reply with at least 2 letters.",
  reg_confirm: "Please confirm your details:\nName: {first_name} {surname}\nID: {identity_mask}\nTown: {location}\nWhatsApp: +{phone}\n\nReply YES to confirm, or the number to change: 1 first name, 2 surname, 3 ID, 4 town.",
  reg_terms: "By entering you confirm you are {min_age} or older and accept the Promotion Terms ({terms_version}) and Privacy Notice ({privacy_version}): {terms_url}\n\nReply YES to accept, or NO to stop.",
  reg_declined: "No problem — nothing has been saved. Reply MENU to start again.",
  registered: "You're registered, {first_name}! Reply 2 to enter the promotion.",
  already_registered: "You're already registered as {first_name} {surname}. Reply 2 to enter, or 1 to update your details.",
  outlet_retailers: "Where did you buy? Choose the SHOP:\n{options}\nReply with a number, or type part of the branch name to search.",
  outlet_branches: "{retailer}: choose the BRANCH:\n{options}\nReply with a number, BACK for the shops, or type to search.",
  outlet_search: "Matching branches:\n{options}\nReply with a number, type again to search, or BACK.",
  outlet_no_match: "No branch matched \"{query}\". Try the town or branch name, or reply BACK for the list.",
  outlet_pick_number: "Please reply with one of the numbers shown, type to search, or BACK.",
  outlet_confirmed: "Outlet: {outlet}.\n\nNow send ONE clear photo of the whole receipt. The shop name, date, receipt number and the sugar line must be readable. Avoid glare and shadows.",
  received: "We have received your receipt. Your submission reference is {reference}. We are checking it now and will message you with the result.",
  still_checking: "Receipt {reference} is still being checked. We'll message you when it's done — no need to send it again.",
  qualified: "Thank you for entering {campaign}! Receipt {reference} qualifies and ONE entry has been added to the draw.{count_line} Good luck!\n\nYou can enter again with a different qualifying receipt — reply 2.",
  qualified_count: " You now have {count} qualified {entries_word}.",
  duplicate: "This receipt has already been used for this promotion, so no new entry was added. Please send a different qualifying receipt — reply 2.",
  not_qualified: "Thanks for receipt {reference}. Unfortunately it does not qualify: {reason}. You can enter with another qualifying receipt — reply 2.",
  reupload: "We couldn't read receipt {reference}: {reason}. Please take a new photo of the whole receipt in good light and send it again — reply 2.",
  under_review: "Receipt {reference} needs a quick check by our team. We'll message you with the result. You can send other receipts in the meantime — reply 2.",
  delayed: "Checking receipt {reference} is taking longer than usual. It is safely stored — please don't send the same receipt again. We'll message you when it's done.",
  review_qualified: "Good news: after review, receipt {reference} qualifies and ONE entry has been added to the draw.{count_line}",
  review_not_qualified: "After review, receipt {reference} does not qualify: {reason}. You can enter with another qualifying receipt — reply 2.",
  review_reupload: "After review, we need a clearer photo of receipt {reference}: {reason}. Please send it again — reply 2.",
  review_duplicate: "After review, receipt {reference} had already been used for this promotion, so no entry was added.",
  status: "Your entries for {campaign}:\nQualified: {qualified}\nBeing checked: {pending}\nNot qualified: {rejected}\n{recent}",
  status_line: "- {reference}: {outcome}",
  status_off: "Entry status isn't available in this promotion. Reply MENU for the other options.",
  mechanics: "How it works: buy at least {min_packs} x {pack_label} of {product} in ONE purchase at a participating outlet, keep the receipt, and send us a photo of it here. Every qualifying receipt earns ONE entry into the draw. Enter as often as you like with different receipts.",
  terms: "Promotion Terms ({terms_version}) and Privacy Notice ({privacy_version}): {terms_url}\nIn short: one entry per qualifying receipt; receipts cannot be reused; winners are verified before prizes are released.",
  prizes: "Prizes: {prizes}\n{artwork}",
  prizes_artwork: "Prize picture: {url}",
  prizes_no_artwork: "(Prize pictures will be shared here once available.)",
  winners_none: "No winners have been published yet. Draws happen every week — check back soon!",
  winners_periods: "Published winners by week:\n{options}\nReply with a number to see that week, or MENU.",
  winners_list: "{period} winners:\n{lines}\n\nReply with another week number, or MENU.",
  winners_line: "{rank}. {name} ({location}) — {prize}",
  support_handoff: "A member of our team will pick this up and reply here. Automatic replies are paused until they close the conversation.",
  support_active: "Our team is handling your conversation. Please wait for their reply.",
  winner_contact: "Congratulations {first_name}! You have been selected as a winner in the {campaign} {period} draw for: {prize}. To claim it we need to verify your details — please reply CLAIM. Your claim reference is {claim_ref}. This offer is valid until {deadline}.",
  winner_collect: "Your prize ({prize}) is ready for collection at {outlet}. Bring your ID and quote the claim reference from our earlier message.",
};
export const REASON_TEXT: Record<string, string> = {
  not_a_receipt: "the image does not look like a till receipt",
  image_unreadable: "the photo is too blurry, dark or cropped to read",
  campaign_not_open: "the promotion was not open at the time",
  not_enrolled: "your registration was not found",
  participant_not_eligible: "you are not eligible under the promotion rules",
  receipt_number_unreadable: "the receipt number is not readable",
  date_unreadable: "the purchase date is not readable",
  date_ambiguous: "the purchase date is unclear",
  date_outside_window: "the purchase date is outside the promotion period",
  outlet_unreadable: "the shop name is not readable",
  outlet_mismatch: "the receipt does not match the outlet you selected",
  outlet_not_participating: "that outlet is not part of this promotion",
  no_qualifying_product: "no qualifying product was found on the receipt",
  quantity_unreadable: "the quantity of the qualifying product is unclear",
  below_minimum: "the qualifying quantity is below the minimum ({min_packs} x {pack_label})",
  entry_cap_reached: "the entry limit for this period has been reached",
  total_unreadable: "the receipt total is not readable",
  duplicate_receipt: "the receipt was already used",
  ownership_dispute: "this receipt was also sent from another phone; our team will check it",
  identity_conflict: "a receipt with the same number was already submitted; our team will check it",
  auto_qualification_paused: "automatic checks are paused; our team will review it",
  reviewer_decision: "our team could not verify the receipt",
};
export type Vars = Record<string, string | number | null | undefined>;
export function render(overrides: Record<string, string> | undefined, key: string, vars: Vars = {}): string {
  const src = overrides?.[key] ?? MESSAGES[key] ?? key;
  return src.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}
export function reasonText(overrides: Record<string, string> | undefined, code: string | null | undefined, vars: Vars = {}): string {
  const src = overrides?.[`reason.${code}`] ?? REASON_TEXT[code ?? ""] ?? String(code ?? "");
  return src.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}
