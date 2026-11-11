export const SECRET = "test-secret";
export const AUTH = { "X-Internal-Secret": SECRET };
export const JSON_AUTH = { "Content-Type": "application/json", ...AUTH };
