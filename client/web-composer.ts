// Compatibility with the web renderer's 0.8.0 button-only composer API.
// Never query the document or change unrelated buttons. Fail closed when the
// expected direct-parent structure changes, leaving the native fallback intact.
type Style = {
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): string;
};
type Element = {
  parentElement: Element | null;
  children: ArrayLike<Element>;
  style: Style;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function expandWebComposer(mount: unknown): (() => void) | null {
  const root = mount as Element | null;
  const slot = root?.parentElement;
  const button = slot?.parentElement;
  if (!slot?.style || !button?.style || button.getAttribute?.("role") !== "button" ||
      slot.children.length !== 1) return null;
  const undo: (() => void)[] = [];
  function patch(element: Element, values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      const previous = element.style.getPropertyValue(key);
      const priority = element.style.getPropertyPriority(key);
      element.style.setProperty(key, value, "important");
      undo.push(() => {
        if (previous) element.style.setProperty(key, previous, priority);
        else element.style.removeProperty(key);
      });
    }
  }
  // Let the original React Native component determine height and wrap its chips.
  patch(slot, { width: "auto", height: "auto", overflow: "visible", "flex-shrink": "1", "min-width": "0", "pointer-events": "auto" });
  patch(button, { "max-width": "100%", "border-width": "0", "background-color": "transparent", "border-radius": "0", padding: "2px 0", height: "auto" });
  for (const child of Array.from(button.children)) {
    if (child !== slot) patch(child, { display: "none" });
  }
  const hidden = slot.getAttribute("aria-hidden");
  slot.removeAttribute("aria-hidden");
  undo.push(() => { if (hidden === null) slot.removeAttribute("aria-hidden"); else slot.setAttribute("aria-hidden", hidden); });
  return () => { for (const restore of undo.reverse()) restore(); };
}
