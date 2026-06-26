// shared intent regexes — a dependency-free leaf module so both the command router and the
// AI context builder classify the same way without pulling each other's heavy deps.

// "what's new / is there an event / current patch / this season" — answered from authoritative
// bazaardb patchnotes (getPatchInfo) so the bot stops deflecting on live-event questions.
export const META_QUERY_RE = /\b(what'?s\s+new|anything\s+new|any\s+news|what'?s\s+(?:happening|going\s+on|changed|up\s+with\s+the\s+game)|current\s+patch|latest\s+patch|new\s+patch|patch\s+notes?|this\s+patch|recent\s+(?:patch|update|changes?)|is\s+there\s+(?:a|an|any)\s+(?:new\s+)?event|any\s+(?:new\s+)?events?|new\s+event|current\s+event|live\s+event|active\s+event|this\s+season|new\s+season|any\s+updates?)\b/i
