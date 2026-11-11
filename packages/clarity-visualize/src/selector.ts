// A bare tag selector such as "div" matches the first element of that tag, so such clicks are skipped
export function usableSelector(selector: string): boolean {
    return !!selector && !/^[a-z][\w-]*$/i.test(selector.trim());
}
