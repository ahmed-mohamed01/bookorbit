/** A lowercase plural ("citizens", "people") or a name for a body of people: never one person or thing. */
export const COLLECTIVE = /^(?:the\s+)?(?:[a-z][a-z\s'-]*[^suis\W]s|people)$|\b(?:Family|House|Clan|Order|People|Council|Guard)\b/;
