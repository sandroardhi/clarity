import { expect, test } from "@playwright/test";
import { usableSelector } from "../src/selector";

test("selector fallback skips bare tag selectors", () => {
    for (const selector of ["div", "BUTTON", " a ", "unknown", "custom-element", "", null]) {
        expect(usableSelector(selector as string), String(selector)).toBe(false);
    }
    for (const selector of ["#buy", "button.primary", "body>div:nth-of-type(2)>a", "[data-id=\"1\"]", "div a"]) {
        expect(usableSelector(selector), selector).toBe(true);
    }
});
